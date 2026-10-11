using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

// .NET Framework 4.8 is included with supported Windows versions. No PowerShell
// evaluation or screen coordinates are used to select a conversation or send.
public static class ClawLinkBridge {
    static readonly TreeWalker Walker = TreeWalker.ControlViewWalker;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16000000 };
    delegate bool WindowCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();

    static Dictionary<string, object> D(params object[] values) {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < values.Length; i += 2) result[(string)values[i]] = values[i + 1];
        return result;
    }
    static string S(IDictionary<string, object> data, string key) { object value; return data != null && data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : ""; }
    static bool B(IDictionary<string, object> data, string key) { object value; return data.TryGetValue(key, out value) && value is bool && (bool)value; }
    static Exception Error(string text) { return new InvalidOperationException(text); }
    static string Executable(IntPtr handle) {
        uint pid; GetWindowThreadProcessId(handle, out pid);
        using (var process = Process.GetProcessById((int)pid)) return Path.GetFullPath(process.MainModule.FileName);
    }
    static string Identity(string file) {
        using (var sha = SHA256.Create()) return "win." + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(file).ToLowerInvariant()))).Replace("-", "").ToLowerInvariant();
    }
    static List<IntPtr> Windows() {
        var windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) { if (IsWindowVisible(h)) windows.Add(h); return true; }, IntPtr.Zero);
        return windows;
    }
    static List<AutomationElement> Children(AutomationElement element) {
        var result = new List<AutomationElement>();
        for (var child = Walker.GetFirstChild(element); child != null && result.Count < 3000; child = Walker.GetNextSibling(child)) result.Add(child);
        return result;
    }
    static string Value(AutomationElement element) {
        object pattern;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return ((ValuePattern)pattern).Current.Value ?? "";
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return ((TextPattern)pattern).DocumentRange.GetText(250000).TrimEnd('\r', '\n');
        throw Error("无法读取输入框内容，未执行发送；请绑定提供 UI Automation 文本接口的输入框");
    }
    static string Text(AutomationElement element, int depth = 0) {
        if (depth > 30) return "";
        object pattern;
        if (element.Current.ControlType == ControlType.Edit) return Value(element);
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return ((TextPattern)pattern).DocumentRange.GetText(250000).TrimEnd('\r', '\n');
        var children = Children(element);
        if (children.Count == 0) return element.Current.Name ?? "";
        var result = String.Join("\n", children.Select(child => Text(child, depth + 1)).Where(value => value.Length > 0));
        if (result.Length > 250000) throw Error("回复容器过大，请选择仅包含当前聊天的区域");
        return result;
    }
    static string Role(AutomationElement element) {
        var type = element.Current.ControlType;
        if (type == ControlType.Edit) return "AXTextArea";
        if (type == ControlType.Button || type == ControlType.Hyperlink) return "AXButton";
        if (type == ControlType.Text) return "AXStaticText";
        if (type == ControlType.Window) return "AXWindow";
        if (type == ControlType.Document) return "AXWebArea";
        return "AXGroup";
    }
    static Dictionary<string, object> Selector(AutomationElement element) {
        return D("role", element.Current.ControlType.ProgrammaticName, "identifier", element.Current.AutomationId ?? "", "name", element.Current.Name ?? "");
    }
    static bool Matches(AutomationElement element, IDictionary<string, object> expected) {
        var actual = Selector(element);
        return new[] { "role", "identifier", "name" }.All(key => S(expected, key) == "" || S(expected, key) == S(actual, key));
    }
    static AutomationElement Resolve(AutomationElement root, string path) {
        if (path == "root") return root;
        var current = root;
        foreach (string part in path.Split('.')) {
            int index; var children = Children(current);
            if (!Int32.TryParse(part, out index) || index < 0 || index >= children.Count) throw Error("绑定元素位置已变化，请重新绑定");
            current = children[index];
        }
        return current;
    }
    static void Search(AutomationElement element, Func<AutomationElement, bool> match, List<AutomationElement> found, ref int budget, int depth = 0) {
        if (depth > 30 || --budget < 0 || found.Count > 1) return;
        if (match(element)) found.Add(element);
        foreach (var child in Children(element)) Search(child, match, found, ref budget, depth + 1);
    }
    static AutomationElement Bound(AutomationElement root, IDictionary<string, object> request, string key) {
        object raw, item; IDictionary<string, object> expected = null;
        if (request.TryGetValue("selectors", out raw) && raw is IDictionary<string, object> && ((IDictionary<string, object>)raw).TryGetValue(key, out item)) expected = item as IDictionary<string, object>;
        try { var element = Resolve(root, S(request, key + "Path")); if (expected == null || Matches(element, expected)) return element; } catch (InvalidOperationException) { }
        if (expected == null || S(expected, "identifier") == "" && S(expected, "name") == "") throw Error("绑定元素身份已变化，请重新绑定：" + key);
        var found = new List<AutomationElement>(); int budget = 5000;
        Search(root, element => Matches(element, expected), found, ref budget);
        if (budget < 0 || found.Count != 1) throw Error("无法唯一定位绑定元素，请重新绑定：" + key);
        return found[0];
    }
    static AutomationElement Window(IDictionary<string, object> request) {
        var file = S(request, "executablePath");
        if (!Path.IsPathRooted(file) || Identity(file) != S(request, "bundleId")) throw Error("Windows 应用身份不符，请从运行中的应用重新绑定");
        var found = new List<AutomationElement>();
        foreach (var h in Windows()) {
            try {
                if (!String.Equals(Executable(h), Path.GetFullPath(file), StringComparison.OrdinalIgnoreCase)) continue;
                var element = AutomationElement.FromHandle(h);
                if (element.Current.Name == S(request, "windowTitle")) found.Add(element);
            } catch (System.ComponentModel.Win32Exception) { } catch (ElementNotAvailableException) { }
        }
        if (found.Count != 1) throw Error("找不到唯一匹配的会话窗口，请打开目标应用和绑定窗口；管理员权限的窗口无法由普通进程控制");
        return found[0];
    }
    static void Invoke(AutomationElement element) {
        object pattern;
        if (!element.Current.IsEnabled || !element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw Error("按钮不支持 UI Automation Invoke，未执行点击");
        ((InvokePattern)pattern).Invoke();
    }
    static void CheckMarker(AutomationElement root, IDictionary<string, object> request) {
        if (S(request, "markerPath") == "" || S(request, "markerText") == "" || Text(Bound(root, request, "marker")) != S(request, "markerText")) throw Error("当前会话标识不符，已停止发送或读取，请打开正确聊天");
    }
    static bool Busy(AutomationElement root, IDictionary<string, object> request) {
        if (S(request, "busyPath") != "" && S(request, "busyText") != "") {
            try { var element = Bound(root, request, "busy"); if (!element.Current.IsOffscreen && Text(element) == S(request, "busyText")) return true; } catch (InvalidOperationException) { }
        }
        var labels = new[] { "stop", "stop generating", "stop response", "stop streaming", "停止", "停止生成", "停止回答", "停止响应" };
        var found = new List<AutomationElement>(); int budget = 5000;
        Search(root, element => element.Current.ControlType == ControlType.Button && !element.Current.IsOffscreen && labels.Contains(element.Current.Name.Trim().ToLowerInvariant()), found, ref budget);
        if (budget < 0) throw Error("窗口元素过多，无法确认生成状态，请选择更小的窗口");
        return found.Count > 0;
    }
    static bool Unlocked() {
        if (!Environment.UserInteractive) return false;
        // DESKTOP_READOBJECTS only: checking the active desktop must never
        // switch desktops or request DESKTOP_SWITCHDESKTOP access.
        var desktop = OpenInputDesktop(0, false, 0x1);
        if (desktop == IntPtr.Zero) return false;
        try {
            var active = new StringBuilder(256); var current = new StringBuilder(256); uint needed;
            if (!GetUserObjectInformation(desktop, 2, active, 512, out needed) ||
                !GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, current, 512, out needed)) return false;
            // Lock and UAC desktops are excluded; only the caller's ordinary
            // interactive desktop is supported.
            return String.Equals(active.ToString(), "Default", StringComparison.OrdinalIgnoreCase) &&
                String.Equals(active.ToString(), current.ToString(), StringComparison.OrdinalIgnoreCase);
        } finally { CloseDesktop(desktop); }
    }
    static object Screenshot() {
        if (!Unlocked()) throw Error("电脑已锁屏或没有交互桌面，未截取屏幕");
        var bounds = Screen.PrimaryScreen.Bounds;
        using (var full = new Bitmap(bounds.Width, bounds.Height)) {
            using (var g = Graphics.FromImage(full)) g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            if (!Unlocked()) throw Error("截图时电脑已锁屏，未返回图片");
            double scale = Math.Min(1.0, 2560.0 / Math.Max(bounds.Width, bounds.Height));
            using (var image = new Bitmap(full, Math.Max(1, (int)(bounds.Width * scale)), Math.Max(1, (int)(bounds.Height * scale))))
            using (var output = new MemoryStream())
            using (var parameters = new EncoderParameters(1)) {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                image.Save(output, ImageCodecInfo.GetImageEncoders().First(codec => codec.MimeType == "image/jpeg"), parameters);
                if (output.Length > 10 * 1024 * 1024) throw Error("截图超过图片大小限制，未返回图片");
                return D("base64", Convert.ToBase64String(output.ToArray()), "mimeType", "image/jpeg");
            }
        }
    }
    static void Inspect(AutomationElement element, string path, List<object> nodes, ref int textBudget, int depth = 0) {
        if (depth > 30 || nodes.Count >= 1500) return;
        string text; try { text = Text(element); } catch (InvalidOperationException) { text = ""; }
        text = text.Substring(0, Math.Min(Math.Min(text.Length, 8000), Math.Max(0, textBudget))); textBudget -= text.Length;
        object pattern; bool invoke = element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern);
        bool writable = element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && !((ValuePattern)pattern).Current.IsReadOnly;
        var name = element.Current.Name ?? "";
        nodes.Add(D("path", path, "role", Role(element), "label", name.Substring(0, Math.Min(name.Length, 300)), "text", text,
            "editable", element.Current.ControlType == ControlType.Edit, "actions", invoke ? new[] { "AXPress" } : new string[0], "selector", Selector(element), "writable", writable));
        var children = Children(element);
        for (int i = 0; i < children.Count; i++) Inspect(children[i], path == "root" ? i.ToString() : path + "." + i, nodes, ref textBudget, depth + 1);
    }
    static void Paste(AutomationElement root, AutomationElement input, string message) {
        var handle = new IntPtr(root.Current.NativeWindowHandle);
        if (!SetForegroundWindow(handle) && GetForegroundWindow() != handle) throw Error("无法切换到目标窗口，未执行粘贴");
        input.SetFocus(); Thread.Sleep(100);
        Action check = () => {
            if (GetForegroundWindow() != handle || !Automation.Compare(AutomationElement.FocusedElement, input)) throw Error("输入焦点已变化，未执行粘贴或发送");
        };
        check();
        // Keep all existing clipboard formats and do not overwrite a user copy
        // made while this operation runs. Clipboard access errors fail closed.
        var original = Clipboard.GetDataObject(); var saved = new DataObject();
        if (original != null) foreach (string format in original.GetFormats(false)) saved.SetData(format, original.GetData(format, false));
        Clipboard.SetText(message); uint ownSequence = GetClipboardSequenceNumber();
        try { check(); SendKeys.SendWait("^v"); Thread.Sleep(250); check(); }
        finally { if (GetClipboardSequenceNumber() == ownSequence) { if (original == null) Clipboard.Clear(); else Clipboard.SetDataObject(saved, true); } }
    }
    static object Perform(IDictionary<string, object> request) {
        string action = S(request, "action");
        if (action == "screenStatus" || action == "screenPermission") return D("allowed", Unlocked(), "requiresPermission", false, "platform", "win32");
        if (action == "screenshot") return Screenshot();
        var target = D("name", "ClawLinkBridge.exe", "path", Process.GetCurrentProcess().MainModule.FileName);
        if (action == "permission") return D("trusted", true, "requiresPermission", false, "permissionTarget", target);
        if (action == "discover") {
            var apps = new Dictionary<string, Dictionary<string, object>>();
            foreach (var h in Windows()) {
                try {
                    string file = Executable(h), id = Identity(file); var window = AutomationElement.FromHandle(h);
                    if (window.Current.Name == "" || file == Process.GetCurrentProcess().MainModule.FileName) continue;
                    if (!apps.ContainsKey(id)) apps[id] = D("bundleId", id, "name", Path.GetFileNameWithoutExtension(file), "path", file, "windows", new List<string>());
                    ((List<string>)apps[id]["windows"]).Add(window.Current.Name);
                } catch (System.ComponentModel.Win32Exception) { } catch (InvalidOperationException) { }
            }
            return D("trusted", true, "platform", "win32", "requiresPermission", false, "permissionTarget", target, "apps", apps.Values.ToArray());
        }
        if (!Unlocked()) throw Error("电脑已锁屏或桌面不可用，未操作会话窗口");
        var root = Window(request);
        if (action == "inspect") { var nodes = new List<object>(); int budget = 500000; Inspect(root, "root", nodes, ref budget); return D("nodes", nodes); }
        if (B(request, "activate")) {
            var handle = new IntPtr(root.Current.NativeWindowHandle);
            if (IsIconic(handle)) ShowWindow(handle, 9);
            if (S(request, "navigationPath") != "") {
                var navigation = Bound(root, request, "navigation");
                if (S(request, "navigationText") == "" || Text(navigation) != S(request, "navigationText")) throw Error("会话入口已变化，请重新绑定");
                Invoke(navigation); Thread.Sleep(1200);
            }
        }
        CheckMarker(root, request);
        var input = Bound(root, request, "input"); var reply = Bound(root, request, "reply");
        if (input.Current.ControlType != ControlType.Edit || input.Current.IsPassword) throw Error("请选择可读取的消息输入框");
        if (action == "capture") return D("text", Text(reply), "busy", Busy(root, request));
        var send = Bound(root, request, "send"); object sendPattern;
        if (!send.TryGetCurrentPattern(InvokePattern.Pattern, out sendPattern)) throw Error("发送按钮不支持 UI Automation Invoke");
        if (action == "validate") {
            var selectors = new Dictionary<string, object>();
            foreach (string key in new[] { "marker", "input", "reply", "send", "navigation", "busy" }) if (S(request, key + "Path") != "") selectors[key] = Selector(Bound(root, request, key));
            Value(input); return D("text", Text(reply), "busy", Busy(root, request), "selectors", selectors);
        }
        if (action != "send" || S(request, "text") == "") throw Error("消息为空或连接器操作无效");
        if (Value(input).Trim() != "") throw Error("原生输入框有未发送草稿，请先处理草稿");
        if (Busy(root, request)) throw Error("原生会话仍在生成，请稍后重试");
        string before = Text(reply), message = S(request, "text"); object valuePattern;
        if (S(request, "writeMode") != "paste" && input.TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern) && !((ValuePattern)valuePattern).Current.IsReadOnly) ((ValuePattern)valuePattern).SetValue(message);
        else Paste(root, input, message);
        if (Value(input) != message) throw Error("写入校验失败，未触发发送；请检查输入框草稿");
        // Re-resolve the window and marker immediately before submission.
        if (!Unlocked()) throw Error("桌面状态已变化，未触发发送");
        root = Window(request); CheckMarker(root, request);
        if (Busy(root, request) || Value(Bound(root, request, "input")) != message) throw Error("会话或输入框状态已变化，未触发发送");
        Invoke(Bound(root, request, "send"));
        return D("sent", true, "before", before);
    }
    [STAThread]
    public static void Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        try {
            var input = Console.In.ReadToEnd();
            if (input.Length > 1000000) throw Error("请求过大");
            Console.Write(Json.Serialize(D("ok", true, "result", Perform(Json.Deserialize<Dictionary<string, object>>(input)))));
        } catch (Exception error) { Console.Write(Json.Serialize(D("ok", false, "error", error.Message))); }
    }
}
