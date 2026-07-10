import AppKit

// Generates the macOS DMG installer background (src-tauri/dmg-background.png),
// referenced by bundle.macOS.dmg in src-tauri/tauri.conf.json. macOS-only.
//
// Regenerate after editing:
//   swift scripts/generate-dmg-background.swift src-tauri/dmg-background.png
//
// The icon slots are left blank here; Finder overlays the app icon and the
// Applications-folder alias at appPosition / applicationFolderPosition (in the
// same 660x400 point space), so keep those config values in sync with the
// arrow/layout below.
//
// Renders the DMG installer background at 2x for Retina crispness.
// Point space is 660x400 (matches windowSize); pixels are 1320x800.

let W: CGFloat = 660, H: CGFloat = 400
let scale: CGFloat = 2
let pxW = Int(W * scale), pxH = Int(H * scale)

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: pxW, pixelsHigh: pxH,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { fatalError("rep") }
rep.size = NSSize(width: W, height: H)

let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = ctx
// rep.size (660x400) over 1320x800 px already maps 1 point -> 2 px, so we draw
// in points and get crisp 2x output with no manual CTM scaling.

func color(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff)/255,
            green: CGFloat((hex >> 8) & 0xff)/255,
            blue: CGFloat(hex & 0xff)/255, alpha: a)
}

// --- background: soft vertical gradient (light, matches the mono icon) ---
let grad = NSGradient(colors: [color(0xFCFCFD), color(0xECEEF2)])!
grad.draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: -90)

// --- text helpers (AppKit origin is bottom-left) ---
func draw(_ s: String, font: NSFont, color c: NSColor, centerX: CGFloat, centerY: CGFloat) {
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: c]
    let sz = (s as NSString).size(withAttributes: attrs)
    (s as NSString).draw(at: NSPoint(x: centerX - sz.width/2, y: centerY - sz.height/2),
                         withAttributes: attrs)
}

// wordmark + subtitle (top area)
draw("memotepad",
     font: .systemFont(ofSize: 30, weight: .semibold), color: color(0x1E1E23),
     centerX: W/2, centerY: 350)
draw("Floating Markdown scratchpad for macOS",
     font: .systemFont(ofSize: 12.5, weight: .regular), color: color(0x9A9AA2),
     centerX: W/2, centerY: 322)

// bottom install hint
draw("Drag  memotepad  onto  the  Applications  folder",
     font: .systemFont(ofSize: 13, weight: .medium), color: color(0x74747C),
     centerX: W/2, centerY: 52)

// --- arrow between the two icon slots (icon centers at point y = 400-172 = 228) ---
let ay: CGFloat = 228
let x0: CGFloat = 256, x1: CGFloat = 404
let arrow = color(0xB9BEC6)
arrow.setStroke()
let line = NSBezierPath()
line.lineWidth = 3
line.lineCapStyle = .round
line.move(to: NSPoint(x: x0, y: ay))
line.line(to: NSPoint(x: x1 - 6, y: ay))
line.stroke()
// arrowhead
arrow.setFill()
let head = NSBezierPath()
head.move(to: NSPoint(x: x1 + 4, y: ay))
head.line(to: NSPoint(x: x1 - 12, y: ay + 9))
head.line(to: NSPoint(x: x1 - 12, y: ay - 9))
head.close()
head.fill()

NSGraphicsContext.restoreGraphicsState()

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "dmg-background.png"
guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("png") }
try! data.write(to: URL(fileURLWithPath: out))
print("wrote \(out) (\(pxW)x\(pxH))")
