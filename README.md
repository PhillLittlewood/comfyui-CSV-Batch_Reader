# CSV Batch Reader

A ComfyUI custom node that reads rows from a CSV file and runs them through your workflow one after another. Press **Run** once and every row is processed. No *Run on Change* or *Auto Queue* needed.

You choose which CSV columns the node reads and what outputs it has, using a **Settings** button on the node. Out of the box it reads `positive`, `negative`, `width`, `height` and `duration`, but you can remove any of those and add your own (a seed, a style, a number of steps, a yes/no flag, and so on).

## Features

- **One-click batch run.** Run once and the node queues each following row itself, stopping after the last one.
- **Follows along.** The `item_number` box shows which row is currently being processed.
- **Cancel and resume.** Cancelling stops the batch and leaves `item_number` on the row it reached, so the next Queue carries on from there.
- **Configurable columns and outputs.** Add or remove columns in Settings. Each has a name, a type (text, integer, float or boolean) and a default.
- **Settings are saved with the workflow.** Each node keeps its own list, so different nodes and workflows can read different columns.
- **Forgiving CSV reading.** Missing columns, empty cells and unreadable values fall back to defaults instead of stopping the run.
- **Preview your CSV.** See the file as a neat table, with each column labelled by the output it feeds, problems flagged, and a click-a-row way to choose where the batch starts.
- **Browse for a CSV.** Pick a file from anywhere on your computer with the **Browse for CSV...** button, or drop files into the `csv_files` folder.

## Installation

1. Put this folder inside ComfyUI's `custom_nodes` folder:

   ```
   cd ComfyUI/custom_nodes
   git clone <your-repo-url> csv_batch_reader
   ```

   Or download it and copy it there. The folder must contain:

   ```
   csv_batch_reader/
   ├── __init__.py
   ├── csv_batch_reader.py
   └── web/
       └── csv_batch_reader.js
   ```

2. Fully restart ComfyUI.
3. Hard-refresh the browser page (`Ctrl+F5`).
4. Add the node: double-click the canvas and search for **CSV Batch Reader** (it is under *Custom → CSV*).

There are no extra Python packages to install.

## Quick start

1. Add the **CSV Batch Reader** node.
2. Click **Browse for CSV...** and choose your CSV file.
3. Click **Preview CSV...** to check the data looks right.
4. Connect the outputs (for example `positive` and `negative`) to your prompt inputs, and `width`, `height` and `duration` to the nodes that need them.
5. Set `item_number` to `1` and leave `run_all_rows` on **Run all rows**.
6. Press **Queue** once.

The workflow runs for row 1, then row 2, and so on to the end of the file.

## The node

| Input | What it does |
|---|---|
| `csv_filename` | The CSV to use. Lists files in the `csv_files` folder next to the node, plus files added with **Browse for CSV...** (shown as `csv_prompts/name.csv`). |
| `item_number` | Which row to use. `1` is the first row after the header. With *Run all rows*, this is the row the batch starts from. |
| `run_all_rows` | **Run all rows**: one Queue runs this row and every row after it. **Single row**: only the row in `item_number` runs. |
| **Preview CSV...** | Shows the selected file as a table. See [Previewing a CSV](#previewing-a-csv). |
| **Settings...** | Opens the window where you choose the columns and outputs. |
| **Browse for CSV...** | Opens a file picker. The file is copied into ComfyUI's `input/csv_prompts` folder and selected. Pick it again after editing the original to refresh the copy. |

**Outputs:** one per column you have set up, in the same order, named after the column. By default: `positive`, `negative`, `width`, `height`, `duration`.

## Previewing a CSV

Click **Preview CSV...** on the node to see the selected file as a table before you run anything.

- **Row numbers** on the left match `item_number`, so row 3 in the table is `item_number` 3.
- **Column labels.** A column that Settings reads is labelled with the output it feeds and its type, for example `→ width · INT`. Columns that Settings doesn't read (such as `Number` or `Notes`) are dimmed and marked *ignored*.
- **Problems are flagged before you run:**
  - A column from Settings that isn't in the CSV is listed at the top with the default that will be used.
  - An empty cell shows the default that will be filled in, for example *(default: 1024)*.
  - A cell that can't be read as its column's type is shown in red with the default it will fall back to, for example `abc → default 1024`.
  - A summary line counts them, or confirms that everything looks good.
- **Click a row** to make it the starting row. It sets `item_number` on the node and highlights the row.
- **Wrap long text** shows long prompts in full instead of cutting them off.
- **Large files.** Only the first 500 rows are shown, and the top of the window says how many rows the file has in total.

The preview uses your current Settings, so it always shows how the node would read the file right now. It reads the file on the computer running ComfyUI and only ever opens `.csv` files from the node's `csv_files` folder or files added with **Browse for CSV...**. Press `Esc` or **Close** to close it.

## Settings

Click **Settings...** on the node. Each line is one column:

| Field | Meaning |
|---|---|
| **Column name** | The column's name in the CSV. The node's output gets the same name. |
| **Output type** | `Text`, `Integer`, `Float` (decimal) or `Boolean` (yes/no). |
| **Default** | Used when the column is missing from the CSV or the cell is empty. |

Buttons: **+ Add column** (up to 16), **✕** to remove a column (at least one must stay), **Reset to defaults**, **Save** and **Cancel**.

What happens when you save:

- The node's outputs change to match your list.
- Outputs you keep stay connected to whatever they were wired to.
- Changing an output's type removes its connection (the old link would no longer fit). Reconnect it afterwards.
- Removed columns lose their connections, and **Reset to defaults** rebuilds every output, so all connections on the node's outputs are removed.
- New columns are always added at the end. Existing columns can't be rearranged; to change the order, remove columns and add them back.

The settings are stored in the workflow, and each node keeps its own.

## CSV format

- A normal `.csv` file, saved as **UTF-8** (in Excel choose *CSV UTF-8*).
- The **first line is the header** with the column names. Every line after it is one row.
- Columns are matched to the names in Settings by name. Capitalisation and extra spaces don't matter (`Width`, `WIDTH` and `width` all match `width`). The old spelling `negetive` is still accepted for `negative`.
- Columns can be in any order. Extra columns that aren't in Settings (such as `Number` or `Notes`) are ignored.
- Columns listed in Settings but missing from the CSV are fine; they use their default.
- Put values that contain commas in double quotes, for example `"text, watermark"`.

### Example with the default settings

```csv
positive,negative,width,height,duration
A cat,"text, watermark",768,512,4.5
A dragon,blur,,,
An apple,"text, watermark",1280,720,6
A monster,,1920,1080,
```

With the default fallbacks (1024 × 1024, 5 seconds):

| Row | Prompt | Size | Duration |
|---|---|---|---|
| 1 | A cat | 768 × 512 | 4.5 s |
| 2 | A dragon | 1024 × 1024 *(defaults)* | 5 s *(default)* |
| 3 | An apple | 1280 × 720 | 6 s |
| 4 | A monster | 1920 × 1080 | 5 s *(default)* |

### Example with your own columns

In Settings, set: `prompt` (Text), `seed` (Integer, default `0`), `upscale` (Boolean, default off), `style` (Text, default `photo`). Then the CSV can be:

```csv
prompt,seed,upscale,style
A cat on a sofa,42,yes,anime
A dragon,,,
An apple,7,no,
```

## Defaults and how values are read

A column's default is used whenever the CSV can't provide a value: the column isn't in the file, the cell is empty, or the cell can't be understood.

| Type | What it accepts |
|---|---|
| **Text** | Used exactly as written. An empty cell gives the default. |
| **Integer** | A whole number. `1024`, `1,024`, `720.0` (rounded) and `6s` (the number is picked out) all work. |
| **Float** | A number with decimals: `4.5`, `6`, `6s`. |
| **Boolean** | `true`/`false`, `yes`/`no`, `y`/`n`, `on`/`off`, `1`/`0`, in any capitals. |

If a cell can't be understood (for example `abc` in a number column), the node uses the default and prints a short note in the ComfyUI console. It does not stop.

Numbers are used exactly as written, including `0` and negative values, so make sure sizes and lengths in your CSV make sense for the nodes they feed.

## Running a batch

- **Run every row:** set `item_number` to the starting row, leave **Run all rows** on, and press Queue once. The next row is queued only after the current one finishes successfully, so nothing runs in parallel.
- **Run one row:** switch to **Single row**, set `item_number`, and Queue.
- **Stop:** press Cancel in ComfyUI. No further rows are queued, and `item_number` stays on the row it reached so you can resume. A failed run also stops the batch.
- **When the last row finishes,** `item_number` returns to the row you started from, so the next Queue runs the whole list again.

## Things to know

- `item_number` counts rows by position, not by any `Number` column in your file.
- If `item_number` is past the end of the CSV, the node stops with an error telling you how many rows the file has. It also stops with a clear error if no CSV is chosen, the file can't be read, or it has a header but no rows.
- Edits to the CSV are picked up on the next run, even if `item_number` hasn't changed. For a file added with **Browse for CSV...**, click Browse and pick the edited file again first.
- Pressing Queue again while a batch is already running starts a second batch. Wait for the first to finish, or cancel it.
- The node has room for up to 16 columns.

## Troubleshooting

**The node doesn't appear.** Check that `csv_batch_reader.py` and `__init__.py` are inside a folder in `custom_nodes`, restart ComfyUI, and look in the console for `IMPORT FAILED` next to the folder name.

**There are no Settings or Browse buttons, or the node shows lots of outputs called `column_1`, `column_2`...** The browser script hasn't loaded. Make sure the node folder contains `__init__.py`, `csv_batch_reader.py` and `web/csv_batch_reader.js`, then restart ComfyUI, hard-refresh the browser, and delete the node and add it again. To test whether the script is being served, open `http://127.0.0.1:8188/extensions/csv_batch_reader/csv_batch_reader.js` (change the port if yours differs, and use your node folder's name). If you see JavaScript it's being served; if you get *not found*, the `web` folder is missing or `__init__.py` isn't exporting it. Until the script loads, the node still works with the five default columns, but the outputs aren't named or trimmed to your settings.

**Only the first row runs.** Check `run_all_rows` is set to **Run all rows**, that you restarted ComfyUI after updating, and that you re-added the node to your workflow.

**The preview says it can't find the file, or shows an error.** Make sure a CSV is selected in `csv_filename`. If you updated the node, restart ComfyUI fully so the preview's server part loads, then hard-refresh the browser.

**The list says `Put_CSV_in_csv_files_folder.csv`.** No CSV files were found. Click **Browse for CSV...**, or put a `.csv` file in the `csv_files` folder next to `csv_batch_reader.py` and reload the page.

**A value isn't what you expected.** Check the column name in Settings matches the CSV header, and look in the console for `Can't use ...` messages, which mean a cell couldn't be understood and the default was used.

**An output lost its connection after changing settings.** Changing an output's type, or removing its column, removes its connection. Reconnect it after saving.

**Upgrading from an older version.** Delete the old node from your workflow and add it again, because its inputs and outputs have changed. You can delete any old `csv_batch_reader_web` folder next to `csv_batch_reader.py`; it is no longer used.
