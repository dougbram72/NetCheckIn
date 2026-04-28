# NetCheckin

NetCheckin is a standalone HAM radio net controller app with its own local SQLite database.

## What it does

- Create and save multiple nets
- Track date, time, frequency, repeater details, or simplex mode
- Build opening and closing scripts from multiple text sections
- Open any script section in a larger editor window
- Keep each roll-call list tied to its own net record
- Reorder roll-call stations with drag and drop
- Create a PDF report with checked-in stations and the full roll-call list
- Look up callsigns from the app's own local database
- Import the FCC ULS zip bundle or files such as `EN.dat` and `AM.dat`
- Choose microphone input devices and request audio permission explicitly
- Attempt system-audio capture through the browser share dialog
- Record push-to-talk audio locally and send it through a desktop STT worker

## Run it

1. Open a terminal in `C:\Dev\NetCheckin`
2. Run `npm start`
3. Open `http://127.0.0.1:3100`

Serving it from `localhost` lets the browser grant microphone access more reliably than opening the HTML file directly.

## Run with Docker

1. Copy `.env.example` to `.env` if you want to override defaults such as the local Ollama endpoint or model.
   Use `.env.docker.example` if you want Docker-specific guidance for Ollama host access.
1. Build and start the container:
   `docker compose up --build`
2. Open `http://127.0.0.1:3100`

Notes:

- The container persists app data through the local `./data` folder.
- `OLLAMA_HOST` defaults to `http://host.docker.internal:11434` so the container can reach a local Ollama instance running on the host.
- Set `OLLAMA_MODEL` in `.env` if you want Docker to pin NetCheckin to a specific local Ollama model.
- The first STT run inside Docker may take a while because the CPU Torch/Torchaudio stack and speech model are large.

## Data storage

NetCheckin creates a local SQLite database at `C:\Dev\NetCheckin\data\netcheckin.db`.

That database stores:

- Nets
- Script sections
- Roll-call stations and their display order
- Callsign lookup records

## FCC import

Use the import area in the Lookup panel to load FCC ULS data files.

Supported file types right now:

- `fcc-amateur.zip`
- `EN.dat`
- `AM.dat`

`fcc-amateur.zip` imports both `EN.dat` and `AM.dat` from the archive in one step.

`EN.dat` imports callsign, operator name, and location data.

`AM.dat` can supplement records with operator class or group information when present.

Use `Download Latest FCC Data` to fetch the current FCC amateur ULS license zip directly from `https://data.fcc.gov/download/pub/uls/complete/l_amat.zip` and import it automatically.

## Notes

- Audio capture happens in the browser, but transcription now runs through a local Python and Torch worker.
- The first STT run may download a local speech model into `C:\Dev\NetCheckin\data\torch-cache`.
- If the built-in callsign parser cannot find a callsign, NetCheckin can ask a local Ollama instance to infer candidates from the transcript and then validates those candidates against the local callsign database.
- Set `OLLAMA_HOST` or `OLLAMA_MODEL` before `npm start` to override the default local Ollama endpoint or model.
- Browser microphone permission is still required even on `localhost` or `127.0.0.1`.
- System-audio capture depends on browser support for display/audio sharing and is less reliable for transcription than microphone mode.
- The app is standalone and does not depend on the separate Callsign application.
- FCC import support here assumes the same pipe-delimited ULS data-file format used by the FCC downloads.
