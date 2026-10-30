// Native foreground segmentation. Keeps original image pixels; generates no face.
// swift scripts/packaging-subject.swift input.jpg output.png
import Foundation
import Vision
import CoreImage
import AppKit

guard [3, 4].contains(CommandLine.arguments.count) else {
  fputs("usage: packaging-subject input.jpg output.png [instance]\n", stderr)
  exit(2)
}
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard #available(macOS 14.0, *) else {
  fputs("Native subject extraction requires macOS 14; use original frames on other systems.\n", stderr)
  exit(1)
}
do {
  let handler = VNImageRequestHandler(url: source)
  let request = VNGeneratePersonInstanceMaskRequest()
  try handler.perform([request])
  guard let result = request.results?.first else {
    throw NSError(domain: "packaging", code: 1, userInfo: [NSLocalizedDescriptionKey: "No person found"])
  }
  let selected: IndexSet
  if CommandLine.arguments.count == 4 {
    guard let index = Int(CommandLine.arguments[3]), result.allInstances.contains(index) else {
      throw NSError(domain: "packaging", code: 2, userInfo: [NSLocalizedDescriptionKey: "Requested person instance not found"])
    }
    selected = IndexSet(integer: index)
  } else { selected = result.allInstances }
  let buffer = try result.generateMaskedImage(ofInstances: selected, from: handler, croppedToInstancesExtent: false)
  let cutout = CIImage(cvPixelBuffer: buffer)
  let context = CIContext()
  try context.writePNGRepresentation(of: cutout, to: output, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
  print(output.lastPathComponent)
} catch {
  fputs("Subject extraction failed: \(error.localizedDescription)\n", stderr)
  exit(1)
}
