# Omega Duel Log

Win-rate statistics from **YGO Omega** replays, in the browser. Load your Omega `Files` folder and slice your game win rate by deck, deck version, card in your opening hand, cards your opponent showed, going first or second, pre- or post-side, opponent deck, and more. Every number shows its win rate, W–L and sample size (N).

Everything runs in the visitor's browser. Nothing is uploaded unless someone uses the **Contribute** tab and agrees to send their data.

## What's in this repository

| Path | What it is |
|---|---|
| `index.html` | The website: Stats, Meta, Decks and Contribute tabs |
| `parser.js` | Reads Omega replays (`.bytes`), decklists (`Player.data`) and deck backups; builds data packs |
| `cards.json` | Card names and archetypes from YGOPRODeck, one card per line |
| `config.js` | Your settings: where contributed data is sent, and your name |
| `apps-script/Code.gs` | The Google Drive drop box that receives contributed data |
| `tools/update_cards.py` | Refreshes `cards.json` (run weekly by the GitHub Action) |
| `tools/omega_tracker.py` | The original command-line version that writes an Excel workbook |
| `.github/workflows/update-cards.yml` | Weekly card-database refresh |

## Set up (once)

### 1. Put the site on GitHub Pages

1. On github.com, create a new **public** repository (for example `omega-duel-log`).
2. Upload every file and folder from this project. On the empty repository page, click **uploading an existing file** and drag them in. The `.github` folder is hidden in Finder (press **Cmd + Shift + .** to show it). If it doesn't come along, use **Add file → Create new file**, name it `.github/workflows/update-cards.yml`, and paste in its contents.
3. Open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and click **Save**.
4. After a minute or two the site is live at `https://<your-username>.github.io/<repository-name>/`.

### 2. Create the Google Drive drop box

1. In Google Drive, make a folder for contributions (for example *Omega Duel Log uploads*). Open it and copy the ID from the address bar: the long code after `/folders/`.
2. Go to [script.google.com](https://script.google.com), click **New project**, and replace the contents of `Code.gs` with `apps-script/Code.gs` from this repository. Paste your folder ID into `FOLDER_ID` and save.
3. Click **Deploy → New deployment**. Under **Select type** choose **Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then **Deploy**.
4. Authorize it when asked. Google shows an "unverified app" warning because you wrote the script yourself: choose **Advanced → Go to (project name)**.
5. Copy the **Web app URL** (it ends in `/exec`). Opening it in a browser should show `"ok":true` and `"folderConfigured":true`.

To change the script later, use **Deploy → Manage deployments → Edit → Version: New version**. The URL stays the same.

**What the drop box accepts.** Before saving anything, the script opens each pack and rejects it unless:
- every file is an Omega replay named like `25_11_27-14_56_22.bytes`, a `Player.data`, a `Backup/Player_….data`, or `contributor.json`;
- the pack contains at least one replay;
- every file is a plausible size (a replay is normally 2–20 KB, and anything over 2 MB is refused);
- the whole pack is no larger than 40 MB.

The website does stricter checks than this: each replay must actually open and read as an Omega game before it's packed. The drop box link is public, though, so these server-side checks are what stop junk sent straight to the link.

**Review before use.** With `REVIEW_FIRST = true` (the default), accepted packs land in `pending/<player id>/`. Move the ones you're happy with into `approved/`, either by hand in Drive or by running `approveAll()` in the script editor (choose it in the function list and click **Run**). Set `REVIEW_FIRST = false` to skip review, so packs go straight to `approved/`.

### 3. Fill in `config.js`

```js
window.OMEGA_CONFIG = {
  uploadUrl: "https://script.google.com/macros/s/…/exec",
  owner: "Your name"
};
```

Commit the change on GitHub (open the file, click the pencil, edit, **Commit changes**). The **Send** button on the Contribute tab appears once `uploadUrl` is set. Until then, contributors can only download their data pack.

## Collecting data from friends

Send them `https://<your-username>.github.io/<repository-name>/#contribute`.

They drag in their Omega `Files` folder, optionally type a name, tick the consent box and click **Send**. The page packs only their replays, `Player.data` and deck backups, a few hundred KB per 50 games. Before anything is sent, it replaces each **opponent's** account number with an anonymous code. The same opponent always gets the same code, so repeat opponents still group together. Each upload lands in your Drive folder as:

```
Omega Duel Log uploads/
  pending/                 ← new uploads wait here for you
    <their player ID>/
      upload_2026-11-22T19-30-00Z_Alex.zip
  approved/                ← analyse this folder
    <player ID>/
      upload_….zip         ← later uploads add newer games
```

**To analyse everyone's data:** in Drive, right-click the `approved` folder → **Download**. Google zips it. Drag that zip (or the unzipped folder) onto the site's Stats tab. Every player's uploads are combined (newer uploads replace older copies of the same file), and a **Player** filter and split appear.

**Data check.** After loading, the panel at the top of the Stats tab lists every player: replays read, files skipped, whether decklists were found, deck backups, and their date range. Skipped files are listed by name with the reason, so a damaged or fake pack stands out. Skipped files never enter the statistics.

## How the numbers are built

- **Game:** one replay file. **Match:** consecutive games against the same opponent less than 45 minutes apart, up to 3.
- **Your deck and version:** the deck list stored in each replay is matched to your saved decks. A new version is recorded whenever Omega's backups (made each time Omega starts) show the list changed.
- **Opponent deck:** named from the archetypes of the non-generic cards the opponent showed across the whole match. Only archetypes with at least 2 cards seen (plus the most common one) are named; generic staples such as hand traps are ignored.
- **Card splits:** "Card in my opening hand", "Card I drew", "Card I played", "Card opponent showed", and "Card from opponent's opening hand". The last one counts only cards the opponent used before their first draw, and is deliberately cautious.
- **Not available from replays:** your opponent's full hand, rank, and whether a game was ranked or casual.

## Card database

`cards.json` comes from the [YGOPRODeck API](https://ygoprodeck.com/api-guide/). The GitHub Action refreshes it every Monday. To run it now, use **Actions → Update card database → Run workflow**.
