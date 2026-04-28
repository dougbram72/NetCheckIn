import json
import sys

import numpy as np
import soundfile as sf
import torch
import torchaudio


torch.set_num_threads(1)

BUNDLE = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
MODEL = BUNDLE.get_model()
MODEL.eval()
LABELS = BUNDLE.get_labels()
SAMPLE_RATE = BUNDLE.sample_rate


def greedy_decode(emission):
    indices = torch.argmax(emission, dim=-1)
    indices = torch.unique_consecutive(indices, dim=-1)
    transcript = "".join(LABELS[index] for index in indices[0].tolist())
    transcript = transcript.replace("-", "")
    transcript = transcript.replace("|", " ").strip()
    if not any(character.isalnum() for character in transcript):
        return ""
    return transcript


def transcribe(audio_path):
    waveform, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
    waveform = np.mean(waveform, axis=1, keepdims=False)
    waveform = torch.from_numpy(waveform).unsqueeze(0)

    if sample_rate != SAMPLE_RATE:
        waveform = torchaudio.functional.resample(waveform, sample_rate, SAMPLE_RATE)

    with torch.inference_mode():
        emission, _ = MODEL(waveform)

    return greedy_decode(emission)


for line in sys.stdin:
    raw = line.strip()
    if not raw:
        continue

    try:
        payload = json.loads(raw)
        transcript = transcribe(payload["audioPath"])
        sys.stdout.write(json.dumps({"id": payload["id"], "transcript": transcript}) + "\n")
        sys.stdout.flush()
    except Exception as exc:
        sys.stdout.write(json.dumps({"id": payload.get("id"), "error": str(exc)}) + "\n")
        sys.stdout.flush()
