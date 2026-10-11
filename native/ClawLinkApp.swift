import Cocoa

final class Launcher: NSObject, NSApplicationDelegate {
    var status: NSStatusItem!
    var service: Process?
    var endpoint: URL?
    var output = ""
    var log: FileHandle?
    var terminating = false
    var opening = false
    var deadline: Timer?
    var dataDirectory: URL!
    var signalSources = [DispatchSourceSignal]()

    func applicationDidFinishLaunching(_ notification: Notification) {
        for value in [SIGTERM, SIGINT] {
            Darwin.signal(value, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
            source.setEventHandler { [weak self] in self?.quit() }; source.resume(); signalSources.append(source)
        }
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "ClawLink")
        status.button?.title = " ClawLink"
        let menu = NSMenu()
        let state = NSMenuItem(title: "服务启动中…", action: nil, keyEquivalent: ""); state.tag = 1; menu.addItem(state)
        menu.addItem(.separator())
        menu.addItem(withTitle: "打开控制台", action: #selector(openConsole), keyEquivalent: "o").target = self
        menu.addItem(withTitle: "查看本地数据", action: #selector(openData), keyEquivalent: "").target = self
        menu.addItem(withTitle: "辅助功能设置", action: #selector(openAccessibility), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出并停止机器人", action: #selector(quit), keyEquivalent: "q").target = self
        status.menu = menu
        do { try startService() } catch { showError(error.localizedDescription) }
    }
    func startService() throws {
        guard let resources = Bundle.main.resourceURL else { throw NSError(domain: "ClawLink", code: 1, userInfo: [NSLocalizedDescriptionKey: "安装包缺少资源，请重新安装。"] ) }
        let environment = ProcessInfo.processInfo.environment
        dataDirectory = environment["CLAWLINK_DATA_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ClawLink", isDirectory: true)
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let logURL = dataDirectory.appendingPathComponent("service.log")
        // Startup diagnostics only; the server never logs chat bodies or tokens.
        FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        log = try FileHandle(forWritingTo: logURL)
        let child = Process()
        child.executableURL = resources.appendingPathComponent("runtime/node")
        child.arguments = [resources.appendingPathComponent("app/server/index.js").path]
        child.currentDirectoryURL = resources.appendingPathComponent("app")
        var env = environment
        env.removeValue(forKey: "NODE_OPTIONS"); env.removeValue(forKey: "NODE_PATH")
        env["PORT"] = "0"; env["NODE_ENV"] = "production"
        env["CLAWLINK_DATA_DIR"] = dataDirectory.path
        env["CLAWLINK_PUBLIC_DIR"] = resources.appendingPathComponent("app/public").path
        env["CLAWLINK_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        child.environment = env
        let stdout = Pipe(); child.standardOutput = stdout; child.standardError = log; child.standardInput = FileHandle.nullDevice
        stdout.fileHandleForReading.readabilityHandler = { [weak self] pipe in
            let bytes = pipe.availableData
            guard !bytes.isEmpty else { pipe.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.readOutput(bytes) }
        }
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.deadline?.invalidate()
                if self.terminating { return }
                self.status.menu?.item(withTag: 1)?.title = "服务已停止"
                let diagnostic = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
                self.showError(diagnostic.isEmpty ? "本地服务意外停止，请重新打开 ClawLink。" : String(diagnostic.suffix(1000)))
            }
        }
        service = child; try child.run()
        deadline = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
            guard let self, self.endpoint == nil else { return }
            self.service?.terminate(); self.showError("本地服务未能及时启动，请查看本地数据目录中的 service.log。")
        }
    }
    func readOutput(_ bytes: Data) {
        try? log?.write(contentsOf: bytes)
        output += String(data: bytes, encoding: .utf8) ?? ""
        guard endpoint == nil, let range = output.range(of: #"ClawLink: http://localhost:\d+"#, options: .regularExpression) else { return }
        let address = String(output[range]).replacingOccurrences(of: "ClawLink: ", with: "")
        guard let url = URL(string: address) else { return }
        endpoint = url; deadline?.invalidate()
        status.menu?.item(withTag: 1)?.title = "ClawLink 正在运行"
        // Persist only the local address for diagnostics, never authentication data.
        let endpointFile = dataDirectory.appendingPathComponent("endpoint.json")
        if let json = try? JSONSerialization.data(withJSONObject: ["url": address, "pid": service?.processIdentifier ?? 0]) {
            try? json.write(to: endpointFile, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: endpointFile.path)
        }
        if ProcessInfo.processInfo.environment["CLAWLINK_NO_OPEN"] != "1" { openConsole() }
    }
    @objc func openConsole() { if let endpoint { NSWorkspace.shared.open(endpoint) } }
    @objc func openData() { if let dataDirectory { NSWorkspace.shared.open(dataDirectory) } }
    @objc func openAccessibility() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!) }
    @objc func quit() { NSApp.terminate(nil) }
    func showError(_ message: String) {
        if opening || terminating { return }; opening = true
        if ProcessInfo.processInfo.environment["CLAWLINK_NO_OPEN"] == "1" {
            FileHandle.standardError.write(Data((message + "\n").utf8)); opening = false; quit(); return
        }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(); alert.messageText = "ClawLink 无法启动"; alert.informativeText = message
        alert.addButton(withTitle: "退出"); alert.runModal(); opening = false; quit()
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let service, service.isRunning else { return .terminateNow }
        terminating = true; service.terminate()
        // A termination request can arrive inside a main-queue signal callback.
        // A bounded wait avoids relying on another main callback to finish quitting.
        let deadline = Date().addingTimeInterval(3)
        while service.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if service.isRunning { Darwin.kill(service.processIdentifier, SIGKILL) }
        return .terminateNow
    }
}
let app = NSApplication.shared
let delegate = Launcher(); app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
