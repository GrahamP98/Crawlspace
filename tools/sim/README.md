# Balance bots

Headless bot runs of `index.html` for balance testing. Each run is one full game. The bot presses the same functions the buttons call, and it only knows what a player could see: tiles it has seen and enemies it has met or spotted with Pathfinder. Needs Windows PowerShell and Microsoft Edge.

```powershell
cd tools\sim
.\batch.ps1 -Pols A_atk,C_crit,E_scout -W 2 -N 300 -Label today   # 3 builds x 2 workers x 300 runs
.\report.ps1 -Label today -Detail
```

`report.ps1` prints the win rate (with its standard error) for each policy, and the share of runs that die on each floor. `-Detail` adds the killers on each floor, averages, win rates by perk, and win rates by worn enchantment. With 12 workers the bots play about 25 runs a second. Keep workers × policies at 12 or fewer, because with more, some results go missing.

## Files

- `bot.js`: the bot. Its strategy knobs and their defaults are at the top in `DEF`.
- `worker.ps1`: one headless Edge on its own port and profile. It plays N runs and writes `res\<Label>\<policy>-<worker>.json`.
- `batch.ps1`: starts the workers. `-Patch name` (or `a+b`) first applies `patches\<name>.txt` to a copy of the game in `games\`. A patch file holds literal `find ==> replace` lines, and `index.html` itself is never changed.
- `report.ps1`: sums up a batch.
- `policies\`: one JSON file per playstyle.
- `patches\package-B.txt`: the optional Ogre King change from the 2026-11-13 study. It is not applied to the game.

## Policies

| Policy | Plays |
|---|---|
| `A_atk` | Attack and Executioner first, fights everything |
| `B_tank` | Vitality, Second Wind, Antidote; Fortitude gear |
| `C_crit` | Focus and Executioner; prefers Swift and Balanced |
| `D_block` | Shield Bash, blocks when it pays; Mending gear |
| `E_scout` | Pathfinder first, fights everything |
| `F_purse` | Tight Purse and redraws; prefers Fortune |
| `G_sustain` | Antidote and Vitality; Mending and Vampiric gear |
| `H_thorns`, `H_fort`, `H_mend` | The same build, with only the armor enchantment changed |
| `smart`, `allin` | A casual player: skips dangerous groups / fights everything |
| `rush` | Heads for the stairs as soon as it knows where they are |
| `X_pfskip` | Exploit: Pathfinder, skipping known dangerous groups |
| `X_redraw`, `X_sw`, `X_scum`, `X_gated` | Exploits: redraw for Attack, stack Second Wind, flee-scout, explore only while healthy |

Results from the 2026-11-13 study with package A applied (700 runs each): A_atk 8.4%, C_crit 8.7%, D_block 9.0%, E_scout 9.0%, H_thorns 10.3%, X_pfskip 11.8%. The win-rate target is 7.5–10%.
