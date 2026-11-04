CSV BATCH READER - COMFYUI NODE
===============================


WHAT IT DOES
------------
CSV Batch Reader reads rows from a CSV file and feeds them into your workflow,
one row at a time. You choose which CSV columns it reads and what outputs the
node has, using the Settings button on the node.

Out of the box it reads five columns: positive, negative, width, height and
duration. You can remove any of those and add your own (for example seed,
style, steps or upscale).

Press Queue once and the node can run every row in the file, one after
another, until it reaches the end. You do not need "Run on Change" or
"Auto Queue" turned on.


INSTALLING
----------
1. Put the whole csv_batch_reader folder inside ComfyUI's custom_nodes folder
   (for example custom_nodes\csv_batch_reader\). It must contain:

       csv_batch_reader\
           __init__.py
           csv_batch_reader.py
           web\
               csv_batch_reader.js

   __init__.py is what makes ComfyUI load the folder, and it also points
   ComfyUI at the "web" folder, which holds the script behind the Settings and
   Browse buttons. If the web folder is missing, the node still runs but you
   will not see those buttons.
2. Fully close and restart ComfyUI.
3. Hard-refresh the browser page (Ctrl+F5).
4. Add the node: double-click the canvas and search for "CSV Batch Reader"
   (it is under Custom > CSV).

If you are updating from an older version, delete the old node from your
workflow and add it again, because its inputs and outputs have changed. You
can also delete the old "csv_batch_reader_web" folder if one was created next
to csv_batch_reader.py by an earlier version. It is no longer used.


THE NODE
--------
csv_filename
    The CSV file to use. The list shows files from two places:
      - the "csv_files" folder next to csv_batch_reader.py
      - files you added with the Browse button (shown as csv_prompts/name.csv)

image_number
    Which row to use. 1 is the first row of the CSV, 2 is the second, and so
    on. With "Run all rows" turned on, this is the row the batch starts from.
    The header line does not count as a row.

run_all_rows
    Run all rows  - one press of Queue runs this row and every row after it
                    until the end of the CSV.
    Single row    - only the row in image_number runs.

Settings... (button)
    Opens the settings window, where you choose the columns and outputs.
    See "SETTINGS" below.

Browse for CSV... (button)
    Opens your normal file picker. The file you choose is copied into
    ComfyUI's input\csv_prompts folder and selected in csv_filename.
    If you edit your original CSV later, click Browse and pick it again to
    replace the copy. (The node itself only ever reads the copy.)

Outputs
    One output per column you set up, in the same order, named after the
    column. By default: positive, negative, width, height, duration.
    Connect them to whatever you need: for example positive to your prompt
    text input, width and height to your image or video size inputs, and
    duration to a video length input.


SETTINGS
--------
Click "Settings..." on the node. Each line in the window is one column:

  Column name     The name of the column in your CSV. The output on the node
                  gets the same name.
  Output type     What kind of value the output gives:
                    Text           words, such as a prompt
                    Integer        whole numbers, such as width or steps
                    Float          numbers with decimals, such as 4.5
                    Boolean        yes/no (true/false)
  Default         Used when the column is missing from the CSV or the cell is
                  empty. See "DEFAULTS" below.

Buttons in the window:
  + Add column        Adds a new line at the bottom (up to 16 columns).
  Remove (x)          Removes that column and its output. (At least one column
                      must stay.)
  Reset to defaults   Puts back the original five columns.
  Save                Applies your changes to the node.
  Cancel              Closes the window without changing anything.

What happens when you save:
  - The node's outputs change to match your list.
  - Outputs you keep stay connected to whatever they were connected to.
  - If you change an output's type (say Integer to Float) and it was
    connected, that connection is removed, because the old connection no
    longer fits. Reconnect it afterwards.
  - Deleted columns lose their connections.
  - "Reset to defaults" rebuilds all the outputs, so every connection on this
    node's outputs is removed.
  - New columns are always added at the end. The order of existing columns
    can't be rearranged; to change the order, remove columns and add them
    back.

Settings are saved with your workflow. Every CSV Batch Reader node keeps its
own settings, so different nodes (or different workflows) can read different
columns. Copying and pasting a node copies its settings too.

If the Settings button is missing, the node still works with the five default
columns. See TROUBLESHOOTING.


HOW THE CSV MUST BE STRUCTURED
------------------------------
- It is a normal .csv file, saved as UTF-8 (in Excel choose "CSV UTF-8").
  Plain "CSV" saved from Excel on Windows can mangle accented characters or
  symbols.
- The FIRST line must be the column names (the header).
- Every line after that is one row. Row 1 is the first line after the header.
- A column is matched by name to the names in Settings. Capital letters and
  extra spaces don't matter (Width, WIDTH and width all match "width"). The
  old spelling "negetive" is still accepted for a column called "negative".
- Columns can be in any order, and the CSV can contain extra columns that
  aren't in Settings (such as a Number or Notes column). The node ignores
  them.
- Columns listed in Settings but missing from the CSV are fine: they simply
  use their default.

Example, with the default settings:

    positive,negative,width,height,duration
    A cat,"text, watermark",768,512,4.5
    A dragon,blur,,,
    An apple,"text, watermark",1280,720,6
    A monster,,1920,1080,

With defaults of 1024 x 1024 and 5 seconds, that gives:

    Row 1:  A cat      768 x 512,   4.5 seconds
    Row 2:  A dragon   1024 x 1024, 5 seconds      (cells empty, so defaults)
    Row 3:  An apple   1280 x 720,  6 seconds
    Row 4:  A monster  1920 x 1080, 5 seconds      (no duration, so default)

Example with your own columns. In Settings you set: prompt (Text), seed
(Integer, default 0), upscale (Boolean, default No), style (Text, default
"photo"). The CSV can then look like this:

    prompt,seed,upscale,style
    A cat on a sofa,42,yes,anime
    A dragon,,,
    An apple,7,no,

Tips:
- If a value contains a comma, put the whole value in double quotes, as in
  "text, watermark" above. Excel and most editors do this for you.
- Empty cells and missing columns are fine.
- Rows that are shorter than the header (missing cells at the end) are fine.


DEFAULTS AND HOW VALUES ARE READ
--------------------------------
The default is what the node uses whenever it can't get a value from the CSV:
the column isn't in the file, the cell is empty, or the cell can't be
understood. The default is set per column in Settings.

  Text      Used exactly as written. An empty cell gives the default.
  Integer   Whole number. Accepts 1024, 1,024, 720.0 (rounded) or 6s (the
            number is picked out of the text).
  Float     Number with decimals. Accepts 4.5, 6, 6s.
  Boolean   Accepts true/false, yes/no, y/n, on/off and 1/0, in any
            capitals.

If a cell can't be understood (for example "abc" in a number column), the node
uses the default and prints a short note in the ComfyUI console window. It
does not stop.

Numbers are used exactly as written, including 0 and negative numbers, so make
sure sizes and lengths in your CSV make sense for the nodes they feed.


USING IT
--------
Run every row (the usual way):
  1. Pick your CSV in csv_filename (or click Browse for CSV...).
  2. Set image_number to 1 (or to whichever row you want to start from).
  3. Leave run_all_rows on "Run all rows".
  4. Press Queue once.

The workflow runs for row 1. When it finishes, the node queues the same
workflow for row 2, and so on until the last row. While it runs, the
image_number box shows which row is being processed. The number changes
when a row starts, so while image 3 is generating the box shows 3.

When the last row finishes, image_number goes back to the row you started
from, so the next Queue runs the whole list again.

Run just one row:
  Set run_all_rows to "Single row", set image_number to the row you want,
  and press Queue.

Stopping:
  Press Cancel in ComfyUI. The batch stops after the current run, and no
  further rows are queued. image_number stays on the row it reached, so you
  can press Queue again to carry on from that row.
  (If a run fails with an error, the batch also stops.)


THINGS TO KNOW
--------------
- image_number counts rows by position, not by any "Number" column that
  might be in your file.
- If image_number is higher than the number of rows in the CSV, the node
  stops with an error that tells you how many rows the file has. It also
  stops with a clear error if no CSV is chosen, the file can't be read, or the
  file has a header but no rows.
- If you edit the CSV file and run again, the node reads the new version,
  even if image_number has not changed. (For a file added with Browse, click
  Browse and pick the edited file again first.)
- The next row is queued only after the current one has finished, so
  nothing runs in parallel and your normal queue order is respected.
- Pressing Queue again while a batch is already running starts a second
  batch. Wait for the first to finish, or cancel it first.
- The node has room for up to 16 columns.


TROUBLESHOOTING
---------------
The node does not appear:
  Make sure csv_batch_reader.py and __init__.py are inside a folder in
  custom_nodes, restart ComfyUI, and look in the ComfyUI console for the
  words "IMPORT FAILED" next to the node's folder name.

There are no Settings or Browse buttons, or the node shows lots of outputs
called column_1, column_2 and so on:
  The browser script has not loaded. Check that the node folder contains
  __init__.py, csv_batch_reader.py and a "web" folder with
  csv_batch_reader.js inside, then fully restart ComfyUI, hard-refresh the
  browser (Ctrl+F5), and delete the node and add it again.
  To test it, open this address in your browser (change 8188 if ComfyUI uses a
  different port, and use your node folder's name):
      http://127.0.0.1:8188/extensions/csv_batch_reader/csv_batch_reader.js
  If you see JavaScript, the file is being served. If you get "not found",
  the web folder is missing or __init__.py is not exporting it.
  Until the script loads, the node still works with the five default columns,
  but the outputs are not named or trimmed to your settings.

Only the first row runs:
  Check run_all_rows is set to "Run all rows". Check you restarted ComfyUI
  after updating the node, and that you re-added the node to your workflow.

The list says "Put_CSV_in_csv_files_folder.csv":
  No CSV files were found. Click Browse for CSV..., or put a .csv file in
  the "csv_files" folder next to csv_batch_reader.py and reload the page.

A value is not what you expected:
  Check the column name in Settings matches the CSV header, and look in the
  console for "Can't use ..." messages, which mean a cell could not be
  understood and the default was used.

An output has the wrong connection after changing settings:
  Changing an output's type removes its connection, and removing a column
  removes its connection. Reconnect the output after saving.
