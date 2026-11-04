"""
CSV Batch Reader - a ComfyUI node that reads rows from a CSV file and can run
every row in one go. Which CSV columns are read, and which outputs the node
has, are set with the Settings button on the node.
"""

import copy
import csv
import json
import os
import re
import ssl
import threading
import time
import urllib.request

MAX_COLUMNS = 16  # most columns/outputs one node can have

# column type (as shown in Settings) -> ComfyUI type
TYPE_NAMES = {"text": "STRING", "int": "INT", "float": "FLOAT", "boolean": "BOOLEAN"}

# What a new node starts with. Each entry: id (stable, used by the Settings
# dialog), name (CSV column and output name), type, default (used when the
# column is missing or the cell is empty).
DEFAULT_COLUMNS = [
    {"id": "positive", "name": "positive", "type": "text", "default": ""},
    {"id": "negative", "name": "negative", "type": "text", "default": ""},
    {"id": "width", "name": "width", "type": "int", "default": 1024},
    {"id": "height", "name": "height", "type": "int", "default": 1024},
    {"id": "duration", "name": "duration", "type": "float", "default": 5.0},
]
DEFAULT_CONFIG = json.dumps({"version": 1, "columns": DEFAULT_COLUMNS})

UPLOAD_SUBFOLDER = "csv_prompts"  # inside ComfyUI's input folder; Browse saves here


def _node_csv_dir():
    return os.path.join(os.path.dirname(os.path.realpath(__file__)), "csv_files")


def _upload_dir():
    try:
        import folder_paths
        return os.path.join(folder_paths.get_input_directory(), UPLOAD_SUBFOLDER)
    except Exception:
        return None


def _list_csvs():
    """CSVs in this node's csv_files folder, plus ones added with the Browse button."""
    names = []
    folder = _node_csv_dir()
    if os.path.isdir(folder):
        names += [f for f in os.listdir(folder) if f.lower().endswith(".csv")]
    upload = _upload_dir()
    if upload and os.path.isdir(upload):
        names += [f"{UPLOAD_SUBFOLDER}/{f}" for f in os.listdir(upload)
                  if f.lower().endswith(".csv")]
    return sorted(names)


def _inside(base, path):
    base, path = os.path.realpath(base), os.path.realpath(path)
    return os.path.commonpath((base, path)) == base


def _csv_path(csv_filename):
    """Full path of the picked CSV (this node's csv_files folder, or one added with Browse)."""
    candidates = [(_node_csv_dir(), csv_filename)]
    if csv_filename.startswith(UPLOAD_SUBFOLDER + "/") and _upload_dir():
        candidates.append((_upload_dir(), csv_filename[len(UPLOAD_SUBFOLDER) + 1:]))
    for base, name in candidates:
        path = os.path.join(base, name)
        if _inside(base, path) and os.path.isfile(path):
            return path
    return os.path.join(_node_csv_dir(), csv_filename)  # not found; read will report it


# ---------------------------------------------------------------- columns

_NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)")
_TRUE = {"true", "yes", "y", "1", "on"}
_FALSE = {"false", "no", "n", "0", "off"}


def _coerce_default(kind, value):
    """Makes a column's default the right Python type for its kind."""
    if kind == "text":
        return "" if value is None else str(value)
    if kind == "boolean":
        return value is True or str(value).strip().lower() in _TRUE
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 0.0
    return int(round(number)) if kind == "int" else number


def _load_columns(config_text):
    """Reads the settings saved in the workflow. Anything unreadable falls back to
    the built-in defaults so the node never breaks on a damaged setting."""
    try:
        data = json.loads(config_text) if config_text else None
        items = data.get("columns") if isinstance(data, dict) else data
        columns = []
        for item in (items or [])[:MAX_COLUMNS]:
            name = str(item.get("name", "")).strip()
            kind = item.get("type", "text")
            if not name or kind not in TYPE_NAMES:
                continue
            columns.append({"name": name, "type": kind,
                            "default": _coerce_default(kind, item.get("default"))})
        if columns:
            return columns
    except Exception as e:
        print(f"[CSV Batch Reader] Column settings could not be read ({e}); using the defaults.")
    return [{"name": c["name"], "type": c["type"],
             "default": _coerce_default(c["type"], c["default"])} for c in DEFAULT_COLUMNS]


def _read_cell(kind, raw, default, label):
    """Turns a CSV cell into the column's type. Empty or unreadable cells give the default."""
    text = raw.strip() if isinstance(raw, str) else ""
    if kind == "text":
        return text if text else default
    if not text:
        return default
    if kind == "boolean":
        if text.lower() in _TRUE:
            return True
        if text.lower() in _FALSE:
            return False
    else:
        match = _NUMBER.search(text.replace(",", ""))
        if match:
            value = float(match.group())
            return int(round(value)) if kind == "int" else value
    print(f"[CSV Batch Reader] Can't use '{text}' for {label}, using the default ({default}).")
    return default


def _queue_next_row_when_finished(prompt_id, prompt, unique_id, extra_pnginfo,
                                  client_id, next_number):
    """Waits for the current run to finish, then queues the same workflow again
    with item_number set to the next row. Does nothing if the run failed or was
    cancelled, so Cancel stops the batch."""
    from server import PromptServer
    server = PromptServer.instance

    if prompt_id is not None:
        entry = None
        deadline = time.time() + 12 * 3600
        while time.time() < deadline:
            time.sleep(0.5)
            found = server.prompt_queue.get_history(prompt_id=prompt_id)
            if prompt_id in found:
                entry = found[prompt_id]
                break
        if entry is None:
            return
        status = entry.get("status") or {}
        messages = status.get("messages") or []
        interrupted = any(m and m[0] == "execution_interrupted" for m in messages)
        if status.get("status_str") != "success" or interrupted:
            print(f"[CSV Batch Reader] Run didn't finish cleanly, stopping the batch "
                  f"before image {next_number}.")
            return
    else:
        time.sleep(1.0)  # very old ComfyUI: can't tell when the run ended

    new_prompt = copy.deepcopy(prompt)
    new_prompt[unique_id]["inputs"]["item_number"] = next_number
    body = {"prompt": new_prompt}
    if client_id:
        body["client_id"] = client_id
    if extra_pnginfo:
        body["extra_data"] = {"extra_pnginfo": extra_pnginfo}

    try:
        from comfy.cli_args import args
        scheme = "https" if getattr(args, "tls_keyfile", None) else "http"
    except Exception:
        scheme = "http"
    url = f"{scheme}://127.0.0.1:{server.port}/prompt"
    request = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    context = ssl._create_unverified_context() if scheme == "https" else None
    try:
        urllib.request.urlopen(request, timeout=30, context=context).read()
    except Exception as e:
        print(f"[CSV Batch Reader] Could not queue image {next_number}: {e}")


class CSVBatchReader:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        # 1. Setup Folder Path
        csv_directory = _node_csv_dir()

        # Create directory if it doesn't exist
        if not os.path.exists(csv_directory):
            try:
                os.makedirs(csv_directory)
            except Exception:
                pass

        files = _list_csvs()
        if not files:
            files = ["Put_CSV_in_csv_files_folder.csv"]

        return {
            "required": {
                "csv_filename": (sorted(files), ),
                # Which row to use (1 = first row of the CSV). With "Run all rows"
                # this is the row the batch starts from.
                "item_number": ("INT", {"default": 1, "min": 1, "max": 1000000}),
                # On: press Queue once and every row from item_number to the end
                # of the CSV runs, one after another. Off: only that one row runs.
                "run_all_rows": ("BOOLEAN", {
                    "default": True,
                    "label_on": "Run all rows",
                    "label_off": "Single row",
                }),
                # The columns and outputs chosen in Settings, stored as JSON. The
                # page hides this box; keeping it a normal input is what saves it
                # inside the workflow and sends it to the server when queued.
                "columns_config": ("STRING", {"default": DEFAULT_CONFIG}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    # The node always offers MAX_COLUMNS sockets of any type; the page (see the
    # script above) trims them to the columns set in Settings and gives each its
    # name and real type.
    RETURN_TYPES = ("*",) * MAX_COLUMNS
    RETURN_NAMES = tuple(f"column_{i + 1}" for i in range(MAX_COLUMNS))
    FUNCTION = "get_prompts"
    CATEGORY = "Custom/CSV"

    @classmethod
    def IS_CHANGED(s, csv_filename, item_number, run_all_rows=True, **kwargs):
        # Re-read when the CSV file is edited, even if the row number is the same.
        try:
            return os.path.getmtime(_csv_path(csv_filename))
        except OSError:
            return float("nan")

    def get_prompts(self, csv_filename, item_number, run_all_rows=True,
                    columns_config=DEFAULT_CONFIG,
                    prompt=None, extra_pnginfo=None, unique_id=None):
        if "Put_CSV" in csv_filename:
            raise ValueError(
                "No CSV selected. Click 'Browse for CSV...' on the node, or put a .csv "
                "file in the csv_files folder next to csv_batch_reader.py.")

        try:
            with open(_csv_path(csv_filename), 'r', encoding='utf-8-sig') as f:
                rows = list(csv.DictReader(f))
        except Exception as e:
            raise ValueError(f"Could not read {csv_filename}: {e}")

        if not rows:
            raise ValueError(
                f"{csv_filename} has no data rows. The first line must be the column "
                "names, with the rows underneath.")

        if item_number > len(rows):
            raise ValueError(
                f"item_number {item_number} is past the end of {csv_filename} "
                f"({len(rows)} rows). Set it between 1 and {len(rows)}.")

        # Column names match however they're capitalised or spaced; any column may be missing.
        row = {(k or "").strip().lower(): v
               for k, v in rows[item_number - 1].items() if k is not None}

        values = []
        for column in _load_columns(columns_config):
            wanted = column["name"].strip().lower()
            names = [wanted] + (["negetive"] if wanted == "negative" else [])  # old spelling
            raw = next((row[n] for n in names if n in row), None)
            values.append(_read_cell(column["type"], raw, column["default"], column["name"]))

        has_more = bool(run_all_rows) and item_number < len(rows)

        # Let the page show which row is running (the item_number box follows along).
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("csv_batch_reader.row", {
                "node": str(unique_id), "row": item_number, "total": len(rows),
                "run_all": bool(run_all_rows), "last": not has_more,
            }, getattr(PromptServer.instance, "client_id", None))
        except Exception:
            pass

        print(f"[CSV Batch Reader] Image {item_number} of {len(rows)}"
              f"{' - next one will be queued when this finishes' if has_more else ''}")

        if has_more and prompt is not None and unique_id is not None:
            try:
                from server import PromptServer
                server = PromptServer.instance
                threading.Thread(
                    target=_queue_next_row_when_finished,
                    args=(getattr(server, "last_prompt_id", None),
                          copy.deepcopy(prompt), str(unique_id),
                          copy.deepcopy(extra_pnginfo),
                          getattr(server, "client_id", None), item_number + 1),
                    daemon=True,
                ).start()
            except Exception as e:
                print(f"[CSV Batch Reader] Could not set up the next image: {e}")

        # one value per chosen column, padded to the node's fixed number of sockets
        return tuple(values) + (None,) * (MAX_COLUMNS - len(values))


# Node Mappings
NODE_CLASS_MAPPINGS = {
    "CSVBatchReader": CSVBatchReader
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CSVBatchReader": "CSV Batch Reader"
}
