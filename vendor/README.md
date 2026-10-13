# vendor - the stock firmware goes here

The build takes the vendor firmware image apart and puts a new root filesystem back into it, so one file has
to be here before you run `./build.sh`:

| File | sha256 |
|---|---|
| `SW.v2.4.1.7.260715.1150.bin` | `bd78be6d67569f0d2f4b3076e6bc895350009966fec400a28f261fc48fedf48d` |

Download it from the EdgeMAX downloads page, <https://www.ui.com/download/edgemax>, section EdgeSwitch XP.
The build checks that sha256 and refuses to work with any other file.

The vendor firmware is **not** distributed with this repository, and nothing you put in this directory is
tracked by git - only this file is.
