import AppKit

enum StatusIcon {
    static func menuBar() -> NSImage {
        let img = loaded(point: 18, names: ["GrokComet-18", "GrokComet-36"])
        img.isTemplate = true
        return img
    }

    static func glyph(size: CGFloat = 16, color: NSColor = .labelColor) -> NSImage {
        let names: [String] = size <= 16
            ? ["GrokComet-16", "GrokComet-32"]
            : ["GrokComet-18", "GrokComet-36"]
        return tinted(loaded(point: size, names: names), color: color, size: size)
    }

    private static func loaded(point: CGFloat, names: [String]) -> NSImage {
        let img = NSImage(size: NSSize(width: point, height: point))
        for name in names {
            guard let url = Bundle.main.url(forResource: name, withExtension: "png"),
                  let data = try? Data(contentsOf: url),
                  let rep = NSBitmapImageRep(data: data) else { continue }
            rep.size = NSSize(width: point, height: point)
            img.addRepresentation(rep)
        }
        if img.representations.isEmpty,
           let url = Bundle.main.url(forResource: "GrokComet", withExtension: "svg"),
           let svg = NSImage(contentsOf: url) {
            for rep in svg.representations {
                img.addRepresentation(rep)
            }
        }
        return img
    }

    private static func tinted(_ image: NSImage, color: NSColor, size: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
            color.set()
            rect.fill(using: .sourceIn)
            return true
        }
    }
}
