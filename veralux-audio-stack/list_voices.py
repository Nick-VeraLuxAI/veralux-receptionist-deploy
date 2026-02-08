from kokoro_onnx import Kokoro

k = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
print("Available Kokoro Voices:")
for v in k.voices:
    print("-", v)

