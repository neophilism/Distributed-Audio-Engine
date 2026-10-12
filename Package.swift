// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DistributedAudioHost",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "DistributedAudioHost", targets: ["DistributedAudioHost"])],
    targets: [
        .target(name: "DAEPCMCore", path: "native/core", exclude: ["tests", "CMakeLists.txt"],
                publicHeadersPath: "include", linkerSettings: [.linkedLibrary("m"), .linkedLibrary("pthread")]),
        .target(name: "DistributedAudioHost", dependencies: ["DAEPCMCore"], path: "native/ios/Sources"),
        .testTarget(name: "DistributedAudioHostTests", dependencies: ["DistributedAudioHost"], path: "native/ios/Tests")
    ],
    cLanguageStandard: .c11
)
