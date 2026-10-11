import Cocoa
import ApplicationServices

func attr(_ element: AXUIElement, _ key: String) -> Any? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ key: String) -> String { attr(element, key) as? String ?? "" }
func children(_ element: AXUIElement) -> [AXUIElement] { attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func label(_ element: AXUIElement) -> String {
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        let value = string(element, key)
        if !value.isEmpty { return value }
    }
    return ""
}
func text(_ element: AXUIElement, depth: Int = 0) -> String {
    if depth > 35 { return "" }
    let role = string(element, kAXRoleAttribute)
    if [kAXStaticTextRole, kAXTextAreaRole, kAXTextFieldRole, kAXHeadingRole].contains(role) {
        return string(element, kAXValueAttribute).isEmpty ? label(element) : string(element, kAXValueAttribute)
    }
    return children(element).map { text($0, depth: depth + 1) }.filter { !$0.isEmpty }.joined(separator: "\n")
}
struct BridgeError: Error { let message: String }
func fail(_ message: String) throws -> Never { throw BridgeError(message: message) }
func permissionTarget() -> [String: String] {
    let process = NSRunningApplication(processIdentifier: ProcessInfo.processInfo.processIdentifier)
    let argumentPath = URL(fileURLWithPath: CommandLine.arguments[0], relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)).standardized.path
    return [
        "name": process?.localizedName ?? URL(fileURLWithPath: CommandLine.arguments[0]).lastPathComponent,
        "path": process?.executableURL?.path ?? argumentPath,
        "bundleId": process?.bundleIdentifier ?? ""
    ]
}
func selector(_ element: AXUIElement) -> [String: String] {
    let role = string(element, kAXRoleAttribute)
    var name = [string(element, kAXTitleAttribute), string(element, kAXDescriptionAttribute)].first { !$0.isEmpty } ?? ""
    if name.isEmpty && [kAXButtonRole, "AXLink", kAXStaticTextRole, kAXHeadingRole].contains(role) {
        name = text(element)
    }
    return ["role": role, "identifier": string(element, kAXIdentifierAttribute), "name": name]
}
func matches(_ element: AXUIElement, _ expected: [String: String]) -> Bool {
    let actual = selector(element)
    return expected.allSatisfy { key, value in value.isEmpty || actual[key] == value }
}
func resolveBound(_ root: AXUIElement, _ request: [String: Any], _ key: String) throws -> AXUIElement {
    let path = request[key + "Path"] as? String ?? ""
    let expected = (request["selectors"] as? [String: [String: String]])?[key]
    if let element = try? resolve(root, path), expected == nil || matches(element, expected!) { return element }
    guard let expected, !(expected["identifier"] ?? "").isEmpty || !(expected["name"] ?? "").isEmpty else {
        try fail("绑定的\(key)元素位置或身份已改变，请重新绑定")
    }
    var found = [AXUIElement]()
    func search(_ element: AXUIElement, _ depth: Int) {
        if depth > 30 || found.count > 1 { return }
        if matches(element, expected) { found.append(element) }
        for child in children(element) { search(child, depth + 1) }
    }
    search(root, 0)
    guard found.count == 1 else { try fail("无法唯一定位绑定的\(key)元素，请重新绑定") }
    return found[0]
}
func applicationRoot(_ app: NSRunningApplication) -> AXUIElement {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    // Electron only exposes the web content tree after accessibility is enabled.
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    return root
}
func resolve(_ root: AXUIElement, _ path: String) throws -> AXUIElement {
    var current = root
    if path == "root" { return current }
    for part in path.split(separator: ".") {
        guard let index = Int(part), children(current).indices.contains(index) else { try fail("绑定元素已改变，请重新检查并绑定会话：\(path)") }
        current = children(current)[index]
    }
    return current
}
func window(_ request: [String: Any]) throws -> (NSRunningApplication, AXUIElement) {
    let bundle = request["bundleId"] as? String ?? ""
    guard !bundle.isEmpty && bundle.count <= 200 && !bundle.contains(where: { $0.isWhitespace }) else { try fail("应用 Bundle ID 无效") }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { try fail("请先打开对应原生应用并登录") }
    let root = applicationRoot(app)
    let windows = attr(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let title = request["windowTitle"] as? String ?? ""
    let matches = windows.filter { string($0, kAXTitleAttribute) == title }
    guard matches.count == 1 else { try fail("找不到唯一匹配的会话窗口，请打开绑定窗口或重新绑定") }
    return (app, matches[0])
}
func inspect(_ element: AXUIElement, path: String, depth: Int, nodes: inout [[String: Any]]) {
    if depth > 30 || nodes.count >= 2000 { return }
    let role = string(element, kAXRoleAttribute)
    let value = label(element)
    let editable = role == kAXTextAreaRole || role == kAXTextFieldRole
    var actions: CFArray?
    AXUIElementCopyActionNames(element, &actions)
    var settable = DarwinBoolean(false)
    AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
    nodes.append(["path": path, "role": role, "label": String(value.prefix(300)), "editable": editable, "text": String(text(element).prefix(8000)), "actions": actions as? [String] ?? [], "selector": selector(element), "writable": settable.boolValue])
    for (i, child) in children(element).enumerated() {
        inspect(child, path: path == "root" ? String(i) : "\(path).\(i)", depth: depth + 1, nodes: &nodes)
    }
}
func checkedWindow(_ request: [String: Any]) throws -> (NSRunningApplication, AXUIElement) {
    let result = try window(request)
    if request["activate"] as? Bool == true {
        result.0.activate()
        AXUIElementPerformAction(result.1, kAXRaiseAction as CFString)
        let navigationPath = request["navigationPath"] as? String ?? ""
        if !navigationPath.isEmpty {
            let navigation = try resolveBound(result.1, request, "navigation")
            let expected = request["navigationText"] as? String ?? ""
            let actual = text(navigation).isEmpty ? label(navigation) : text(navigation)
            guard !expected.isEmpty && actual == expected else { try fail("会话切换入口已改变，请重新绑定") }
            guard AXUIElementPerformAction(navigation, kAXPressAction as CFString) == .success else { try fail("无法打开绑定会话，请手动打开正确会话") }
            Thread.sleep(forTimeInterval: 1.2)
        }
    }
    let markerPath = request["markerPath"] as? String ?? ""
    let markerText = request["markerText"] as? String ?? ""
    guard !markerPath.isEmpty && !markerText.isEmpty else { try fail("必须绑定会话标识元素，防止消息发送到错误会话") }
    let actual = text(try resolveBound(result.1, request, "marker"))
    guard actual == markerText else { try fail("当前原生会话与绑定会话不符，已停止发送，请打开正确会话") }
    return result
}
func isBusy(_ root: AXUIElement, _ request: [String: Any]) -> Bool {
    if let path = request["busyPath"] as? String, !path.isEmpty,
       let element = try? resolveBound(root, request, "busy"), let expected = request["busyText"] as? String, !expected.isEmpty,
       text(element) == expected || label(element) == expected { return true }
    func scan(_ element: AXUIElement, _ depth: Int) -> Bool {
        if depth > 30 { return false }
        let title = label(element).lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        let stopLabels = ["stop generating", "stop response", "stop streaming", "stop", "停止生成", "停止回答", "停止响应", "停止"]
        if string(element, kAXRoleAttribute) == kAXButtonRole && stopLabels.contains(title) { return true }
        return children(element).contains { scan($0, depth + 1) }
    }
    return scan(root, 0)
}
func pasteMessage(_ message: String, _ input: AXUIElement, _ app: NSRunningApplication) throws {
    app.activate()
    AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    for _ in 0..<10 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { break }
        Thread.sleep(forTimeInterval: 0.1)
    }
    func checkFocus() throws {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              let focused = attr(applicationRoot(app), kAXFocusedUIElementAttribute) else { try fail("无法确认原生输入框焦点，未执行粘贴") }
        guard CFEqual(focused as CFTypeRef, input) else { try fail("输入焦点不属于绑定消息框，未执行粘贴") }
    }
    try checkFocus()
    let pasteboard = NSPasteboard.general
    let previous = (pasteboard.pasteboardItems ?? []).map { item -> NSPasteboardItem in
        let copy = NSPasteboardItem()
        for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
        return copy
    }
    pasteboard.clearContents()
    var ownChange = pasteboard.changeCount
    defer {
        if pasteboard.changeCount == ownChange { pasteboard.clearContents(); pasteboard.writeObjects(previous) }
    }
    let prepared = pasteboard.setString(message, forType: .string)
    ownChange = pasteboard.changeCount
    guard prepared else { try fail("无法准备原生消息粘贴") }
    func shortcut(_ code: CGKeyCode) throws {
        try checkFocus()
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { try fail("无法创建原生输入事件") }
        down.flags = .maskCommand; up.flags = .maskCommand
        down.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier)
        Thread.sleep(forTimeInterval: 0.1)
    }
    if !string(input, kAXValueAttribute).isEmpty { try shortcut(0) } // Select only the verified input's contents.
    try shortcut(9)
    for _ in 0..<20 {
        if string(input, kAXValueAttribute) == message { return }
        Thread.sleep(forTimeInterval: 0.1)
    }
    try fail("粘贴内容未通过校验，未触发发送，请检查原生草稿")
}
func run(_ request: [String: Any]) throws -> [String: Any] {
    let action = request["action"] as? String ?? "discover"
    if action == "permission" {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return ["trusted": AXIsProcessTrustedWithOptions(options), "permissionTarget": permissionTarget()]
    }
    if action == "discover" {
        let currentPid = ProcessInfo.processInfo.processIdentifier
        let apps = NSWorkspace.shared.runningApplications.compactMap { app -> [String: Any]? in
            guard app.processIdentifier != currentPid,
                  let bundle = app.bundleIdentifier, !bundle.isEmpty,
                  app.activationPolicy == .regular || bundle.hasPrefix("dev.clawlink.") else { return nil }
            let windows = attr(applicationRoot(app), kAXWindowsAttribute) as? [AXUIElement] ?? []
            return ["bundleId": bundle, "name": app.localizedName ?? bundle, "path": app.executableURL?.path ?? "", "windows": windows.map { string($0, kAXTitleAttribute) }]
        }
        return ["trusted": AXIsProcessTrusted(), "permissionTarget": permissionTarget(), "apps": apps]
    }
    guard AXIsProcessTrusted() else { try fail("请在系统设置 → 隐私与安全性 → 辅助功能中允许 ClawLinkBridge（或启动它的终端），然后重试") }
    if action == "inspect" {
        let (_, root) = try window(request)
        var nodes = [[String: Any]]()
        inspect(root, path: "root", depth: 0, nodes: &nodes)
        return ["nodes": nodes]
    }
    let (app, root) = try checkedWindow(request)
    let inputPath = request["inputPath"] as? String ?? ""
    let replyPath = request["replyPath"] as? String ?? ""
    guard !inputPath.isEmpty && !replyPath.isEmpty else { try fail("请绑定消息输入框与回复容器") }
    let input = try resolveBound(root, request, "input")
    guard [kAXTextAreaRole, kAXTextFieldRole].contains(string(input, kAXRoleAttribute)) else { try fail("绑定的输入框类型不正确") }
    let reply = try resolveBound(root, request, "reply")
    let sendPath = request["sendPath"] as? String ?? ""
    guard !sendPath.isEmpty else { try fail("必须绑定发送按钮") }
    if action == "capture" || action == "validate" {
        if action == "validate" {
            let send = try resolveBound(root, request, "send")
            guard string(send, kAXRoleAttribute) == kAXButtonRole else { try fail("请选择原生发送按钮") }
            var selectors = [String: [String: String]]()
            for key in ["marker", "input", "reply", "send", "navigation", "busy"] {
                if !(request[key + "Path"] as? String ?? "").isEmpty { selectors[key] = selector(try resolveBound(root, request, key)) }
            }
            return ["text": text(reply), "inputRole": string(input, kAXRoleAttribute), "busy": isBusy(root, request), "selectors": selectors]
        }
        return ["text": text(reply), "inputRole": string(input, kAXRoleAttribute), "busy": isBusy(root, request)]
    }
    guard action == "send", let message = request["text"] as? String, !message.isEmpty else { try fail("消息不能为空") }
    let existing = string(input, kAXValueAttribute)
    guard existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { try fail("原生输入框有未发送草稿，请先处理草稿") }
    guard !isBusy(root, request) else { try fail("原生会话仍在生成上一条回复，请稍后重试") }
    let before = text(reply)
    app.activate()
    AXUIElementPerformAction(root, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    // Electron editors need a real input event to update their component state.
    if app.bundleIdentifier == "com.anthropic.claudefordesktop" || request["writeMode"] as? String == "paste" {
        try pasteMessage(message, input, app)
    } else if AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, message as CFString) != .success {
        try pasteMessage(message, input, app)
    }
    guard string(input, kAXValueAttribute) == message else { try fail("写入校验失败，未触发发送") }
    // Recheck marker after input; submission always presses the bound AX button.
    let marker = text(try resolveBound(root, request, "marker"))
    guard marker == request["markerText"] as? String else { try fail("写入后会话标识改变，已停止发送") }
    let send = try resolveBound(root, request, "send")
    guard string(send, kAXRoleAttribute) == kAXButtonRole else { try fail("发送元素不再是按钮") }
    guard attr(send, kAXEnabledAttribute) as? Bool != false else { try fail("发送按钮未启用，请检查原生输入框是否支持写入") }
    guard AXUIElementPerformAction(send, kAXPressAction as CFString) == .success else { try fail("无法点击绑定的发送按钮，请检查原生草稿") }
    // AXPress succeeding does not prove that the app accepted the message.
    for _ in 0..<12 {
        Thread.sleep(forTimeInterval: 0.2)
        if let current = try? resolveBound(root, request, "input"),
           [kAXTextAreaRole, kAXTextFieldRole].contains(string(current, kAXRoleAttribute)),
           string(current, kAXValueAttribute).isEmpty {
            return ["sent": true, "before": before]
        }
        if isBusy(root, request) { return ["sent": true, "before": before] }
    }
    try fail("发送按钮已点击，但原生应用未确认提交。请检查会话及草稿，勿自动重发")
}
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let request = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    let output = try JSONSerialization.data(withJSONObject: ["ok": true, "result": run(request)], options: [.sortedKeys])
    print(String(data: output, encoding: .utf8)!)
} catch {
    let message = (error as? BridgeError)?.message ?? "原生连接器执行失败"
    let output = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message])
    print(String(data: output, encoding: .utf8)!)
    exit(1)
}
