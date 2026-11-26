import AppKit
import DSHProxyKit
import SwiftUI

/// File-based voice operations only. Opening this view never contacts ElevenLabs.
struct VoicePage: View {
    @ObservedObject var store: AppStore
    @State private var model = "eleven_v4"
    @State private var speaker = ""
    @State private var input = ""
    @State private var output = ""
    @State private var busy = false
    @State private var result = "Nothing has been sent."
    private var operation: String { model == "scribe_v3_live" ? "live" : model.hasPrefix("scribe_") ? "transcribe" : model == "eleven_multilingual_sts_v2" ? "change" : "tts" }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("ElevenLabs Voice").font(.title2.bold())
                Text("Uses the same elevenlabs API key as Video. No automatic generation, retry or provider fallback. Your input is sent only after you confirm a paid request.").foregroundStyle(.secondary)
                Button("Manage shared ElevenLabs key") { store.go(.video, .apiKeys) }
                Link("Browse official ElevenLabs voice library", destination: URL(string: "https://elevenlabs.io/app/voice-library")!)
                Picker("Model", selection: $model) {
                    ForEach(VoiceRequest.models, id: \.self) { Text($0).tag($0) }
                }
                if operation == "live" { Text("Live transcription input: raw PCM16 little-endian, mono, 16 kHz; 2 to 30 seconds. No speaker ID required.").foregroundStyle(.secondary) }
                if model == "scribe_v2_medical" { Text("Medical use requires appropriate agreements, including a BAA for PHI. Provider retention defaults apply; this app makes no compliance guarantee.").foregroundStyle(.orange) }
                if operation != "transcribe" && operation != "live" { TextField("Speaker / voice ID (not the model)", text: $speaker) }
                HStack {
                    TextField(operation == "tts" ? "UTF-8 text file" : "Audio file", text: $input)
                    Button("Choose input…") {
                        let panel = NSOpenPanel(); panel.canChooseDirectories = false
                        if panel.runModal() == .OK { input = panel.url?.path ?? "" }
                    }
                }
                HStack {
                    TextField("Output file path", text: $output)
                    Button("Choose output…") {
                        let panel = NSSavePanel(); panel.nameFieldStringValue = (operation == "transcribe" || operation == "live") ? "transcript.json" : "speech.mp3"
                        if panel.runModal() == .OK { output = panel.url?.path ?? "" }
                    }
                }
                Text("Output must be a new file. Transcription uses audio; TTS uses a text file and a separate speaker ID; voice changing uses audio and a target speaker.").font(.callout).foregroundStyle(.secondary)
                Button(busy ? "Request in progress…" : "Review paid request…") { Task { await submit() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || store.isSample || input.isEmpty || output.isEmpty || (operation != "transcribe" && operation != "live" && speaker.isEmpty))
                Text(result).textSelection(.enabled)
            }.padding(24).disabled(busy)
        }
    }
    private func submit() async {
        guard !busy, !store.isSample else { return }
        guard FileManager.default.fileExists(atPath: input), !FileManager.default.fileExists(atPath: output),
              let args = VoiceRequest.arguments(model: model, speaker: speaker, input: input, output: output) else {
            result = "Choose an existing input, a new absolute output path, and a valid speaker ID when required."
            return
        }
        busy = true
        defer { busy = false }
        guard await store.confirm("Paid ElevenLabs request", "Send this input to ElevenLabs using \(model)?\n\nInput: \(input)\nOutput: \(output)\n\nCharges depend on your ElevenLabs account. This is not a price quote. The request is sent once; an uncertain result is never retried automatically.", yes: "Send paid request") else { return }
        guard let answer = await store.cli(args, timeout: 180) else { result = "No result. Check your ElevenLabs history before trying again."; return }
        result = answer.code == 0 ? AppStore.text(answer) : "Request did not complete successfully. Check ElevenLabs history before retrying.\n" + AppStore.text(answer)
    }
}
