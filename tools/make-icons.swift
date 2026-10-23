import AppKit
// 把 macOS 圆角 App 图标做成 iPhone 主屏幕用的满版方形图标：背景取图标自身的颜色，图案保持原比例居中。
// 用法：swift make-icons.swift <源图.png> <裁边比例，如 0.015> <尺寸...>，输出 icon-<尺寸>.png 到当前目录。
let args = CommandLine.arguments
guard args.count >= 4, let img = NSImage(contentsOfFile: args[1]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let w = cg.width, h = cg.height
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
let px = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4)
var minX = w, minY = h, maxX = 0, maxY = 0
for y in 0..<h { for x in 0..<w { if px[(y * w + x) * 4 + 3] > 200 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } } }
let bw = maxX - minX, bh = maxY - minY
let sx = minX + bw / 12, sy = minY + bh / 2, o = (sy * w + sx) * 4
let a = max(CGFloat(px[o + 3]) / 255, 0.01)
let bg = CGColor(red: CGFloat(px[o]) / 255 / a, green: CGFloat(px[o + 1]) / 255 / a, blue: CGFloat(px[o + 2]) / 255 / a, alpha: 1)
let inset = Int(Double(bw) * (Double(args[2]) ?? 0))
let crop = cg.cropping(to: CGRect(x: minX + inset, y: minY + inset, width: bw - 2 * inset, height: bh - 2 * inset))!
for size in args[3...].compactMap({ Int($0) }) {
  let out = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  out.setFillColor(bg)
  out.fill(CGRect(x: 0, y: 0, width: size, height: size))
  out.interpolationQuality = .high
  out.draw(crop, in: CGRect(x: 0, y: 0, width: size, height: size))
  let rep = NSBitmapImageRep(cgImage: out.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "icon-\(size).png"))
}
