import Cocoa
let directory = CommandLine.arguments[1]
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let s = CGFloat(pixels)
        NSColor(calibratedRed: 16/255, green: 32/255, blue: 51/255, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: s * 0.04, y: s * 0.04, width: s * 0.92, height: s * 0.92), xRadius: s * 0.20, yRadius: s * 0.20).fill()
        for (index, height) in [0.31, 0.48, 0.38].enumerated() {
            NSColor(calibratedRed: 243/255, green: 125/255, blue: 75/255, alpha: index == 0 ? 0.75 : 1).setFill()
            let x = s * (0.24 + Double(index) * 0.19), y = s * 0.25
            let path = NSBezierPath(); path.move(to: NSPoint(x: x, y: y)); path.line(to: NSPoint(x: x + s * 0.11, y: y))
            path.line(to: NSPoint(x: x + s * 0.20, y: y + s * height)); path.line(to: NSPoint(x: x + s * 0.09, y: y + s * height)); path.close(); path.fill()
        }
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(directory)/icon_\(size)x\(size)\(suffix).png"))
    }
}
