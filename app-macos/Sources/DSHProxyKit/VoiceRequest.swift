import Foundation

/// Explicit file-based requests; constructing arguments performs no network or disk work.
public enum VoiceRequest {
    public static let models = ["eleven_v4", "eleven_v4_turbo", "eleven_flash_v2_5", "eleven_flash_v2", "scribe_v3", "scribe_v3_live", "scribe_v2_medical", "eleven_multilingual_sts_v2"]
    public static func arguments(model: String, speaker: String, input: String, output: String) -> [String]? {
        guard models.contains(model),
              input.hasPrefix("/"), output.hasPrefix("/"), input != output else { return nil }
        let operation = model == "scribe_v3_live" ? "live" : model.hasPrefix("scribe_") ? "transcribe" : model == "eleven_multilingual_sts_v2" ? "change" : "tts"
        var args = ["voice", operation, model]
        if operation != "transcribe" && operation != "live" {
            guard !speaker.isEmpty, speaker.count <= 128, speaker.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { return nil }
            args += ["--voice", speaker]
        }
        args += [operation == "tts" ? "--text-file" : "--input", input, "--output", output, "--confirm-charge"]
        return args
    }
}
