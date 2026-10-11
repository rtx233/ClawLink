import Cocoa

final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let marker = NSTextField(labelWithString: "fixture-one")
    let input = NSTextView(frame: NSRect(x: 0, y: 0, width: 450, height: 80))
    let reply = NSTextView(frame: NSRect(x: 0, y: 0, width: 450, height: 180))
    var active = "one"
    var histories = ["one": "历史一", "two": "历史二"]
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let item = NSMenuItem(); item.submenu = edit; menu.addItem(item); NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 520, height: 450), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "ClawLink Native Fixture"
        let view = window.contentView!
        marker.frame = NSRect(x: 25, y: 400, width: 450, height: 24)
        marker.setAccessibilityIdentifier("conversation-marker")
        view.addSubview(marker)
        for (index, title) in ["会话一", "会话二"].enumerated() {
            let button = NSButton(title: title, target: self, action: #selector(switchConversation(_:)))
            button.tag = index; button.frame = NSRect(x: 25 + index * 120, y: 355, width: 105, height: 30)
            button.setAccessibilityIdentifier("navigation-\(index)")
            view.addSubview(button)
        }
        reply.isEditable = false; reply.isRichText = false; reply.string = histories[active]!
        reply.setAccessibilityIdentifier("conversation-reply")
        let replies = NSScrollView(frame: NSRect(x: 25, y: 155, width: 450, height: 185))
        replies.documentView = reply; replies.hasVerticalScroller = true; view.addSubview(replies)
        input.isRichText = false; input.setAccessibilityIdentifier("conversation-input")
        let inputs = NSScrollView(frame: NSRect(x: 25, y: 55, width: 450, height: 80))
        inputs.documentView = input; view.addSubview(inputs)
        let send = NSButton(title: "发送", target: self, action: #selector(sendMessage))
        send.frame = NSRect(x: 380, y: 12, width: 95, height: 30); send.setAccessibilityIdentifier("send-message")
        view.addSubview(send)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc func switchConversation(_ sender: NSButton) {
        active = sender.tag == 0 ? "one" : "two"
        marker.stringValue = "fixture-\(active)"; reply.string = histories[active]!
    }
    @objc func sendMessage() {
        guard !input.string.isEmpty else { return }
        let prompt = input.string
        input.string = ""
        histories[active]! += "\n\(prompt)\n回复[\(active)]：\(prompt)"
        reply.string = histories[active]!
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = Fixture(); app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
