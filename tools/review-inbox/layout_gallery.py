#!/usr/bin/env python3
"""Generate a read-only comparison gallery from the production TUI layouts.

All layout and content come from `review-inbox designs --snapshot`.
The saved gallery never mutates inbox state or changes layout preferences.
"""

import argparse
import json
from pathlib import Path
import subprocess
import uuid


DESIGNS = [
    {
        "slug": "ledger",
        "name": "Ledger",
        "kicker": "THE PRECISE QUEUE",
        "description": "A compact register with single-row items, a dedicated labels column, and a quiet inspector. Alignment and selection establish the hierarchy.",
        "strength": "Best for scanning and clearing a busy queue.",
        "consider": "Does the density help you decide faster, or make the hub feel too much like a table?",
        "inspiration": "gh-dash",
        "link": "https://www.gh-dash.dev/",
    },
    {
        "slug": "dispatch",
        "name": "Dispatch",
        "kicker": "THE READING ROOM",
        "description": "An editorial surface with a masthead, a slim contents index, and a generous reading measure. Review labels sit beside the story in the index.",
        "strength": "Best for daily briefs and considered reading.",
        "consider": "Would this make you want to read a digest, and is enough of the rest of the inbox still visible?",
        "inspiration": "Glow",
        "link": "https://github.com/charmbracelet/glow",
    },
    {
        "slug": "navigator",
        "name": "Navigator",
        "kicker": "THE WORKSPACE",
        "description": "A three-pane composition: a source rail, an item list, and a reader. Category labels live directly beneath review titles.",
        "strength": "Best for moving between several information sources.",
        "consider": "Does a persistent source rail make the hub easier to navigate, or use space you would rather give to content?",
        "inspiration": "Yazi",
        "link": "https://yazi-rs.github.io/features/",
    },
    {
        "slug": "stream",
        "name": "Stream",
        "kicker": "THE ACTIVITY FEED",
        "description": "A sequence of activity above a broad reading surface. Timestamps and review labels help scan the feed before reading in the horizontal pane.",
        "strength": "Best for a quick catch-up followed by a closer look.",
        "consider": "Is the horizontal reader a better use of width, or does it leave too little room for long content?",
        "inspiration": "Lazygit",
        "link": "https://github.com/jesseduffield/lazygit",
    },
    {
        "slug": "overview",
        "name": "Overview",
        "kicker": "THE INFORMATION DESK",
        "description": "Two parallel queues separate reviews from reading, above a shared preview. Review labels identify categories without opening each item.",
        "strength": "Best for deciding which kind of attention to give next.",
        "consider": "Does seeing reviews and briefs together make the next choice clearer, or divide your attention?",
        "inspiration": "Lazygit",
        "link": "https://github.com/jesseduffield/lazygit",
    },
]

SIZES = {
    "desktop": (120, 38),
    "compact": (80, 32),
    "phone": (44, 32),
}


def capture_frames(command):
    styles = []
    style_ids = {}
    frames = {}
    for design in DESIGNS:
        slug = design["slug"]
        frames[slug] = {}
        for size, (width, height) in SIZES.items():
            result = subprocess.run(
                [
                    str(command), "designs", "--skin", slug, "--snapshot",
                    "--width", str(width), "--height", str(height),
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            frame = json.loads(result.stdout)
            rows = []
            for row in frame["rows"]:
                runs = []
                for run in row:
                    style = (run["fg"], run["bg"], bool(run.get("bold")))
                    if style not in style_ids:
                        style_ids[style] = len(styles)
                        styles.append(style)
                    runs.append([style_ids[style], run["text"]])
                rows.append(runs)
            frames[slug][size] = {
                "width": frame["width"],
                "height": frame["height"],
                "rows": rows,
            }
    return {"designs": DESIGNS, "styles": styles, "frames": frames}


PAGE = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inbox - five layouts</title>
<style>
*{box-sizing:border-box}
:root{color-scheme:dark light;--paper:var(--background,#1F1F28);--ink:var(--foreground,#DCD7BA);--muted:var(--muted-foreground,#938AA9);--line:var(--border,#54546D);--accent:#7E9CD8}
body{margin:0;padding:28px 22px 18px;background:var(--paper);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.eyebrow{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:10px;letter-spacing:.19em;text-transform:uppercase}
.eyebrow:before{content:"";width:18px;height:1px;background:var(--accent)}
h1{margin:10px 0 8px;font-size:clamp(23px,4.2vw,32px);line-height:1.2;letter-spacing:-.045em;font-weight:620}
.intro{max-width:600px;margin:0;color:var(--muted);font-size:13px;line-height:1.65}
.tabs{display:flex;gap:5px;margin:24px 0 25px;padding:0 0 9px;border-bottom:1px solid var(--line)}
.tab{flex:1;min-width:0;padding:8px 5px 7px;border:0;border-radius:5px;background:transparent;text-align:left;color:var(--muted);white-space:nowrap;font-size:12px}
.tab .num{display:block;font-size:9px;letter-spacing:.12em;opacity:.65;margin-bottom:1px}
.tab[aria-selected="true"]{background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--ink)}
.tab[aria-selected="true"] .num{color:var(--accent);opacity:1}
.tab:hover{background:color-mix(in srgb,var(--ink) 5%,transparent)}
.design-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px}
.kicker{margin:0 0 5px;color:var(--accent);font-size:9px;letter-spacing:.17em;font-weight:650}
h2{margin:0;font-size:25px;line-height:1.15;letter-spacing:-.035em;font-weight:610}
.design-number{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding-top:3px;white-space:nowrap}
.description{margin:12px 0 9px;color:var(--muted);font-size:13px;line-height:1.65;max-width:610px;min-height:43px}
.strength{margin:0 0 20px;font-size:11px;color:var(--ink)}
.strength:before{content:"↳";color:var(--accent);margin-right:8px}
.terminal-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px;flex-wrap:wrap}
.sizes{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--line);border-radius:6px}
.sizes button{padding:4px 8px;border:0;border-radius:3px;background:transparent;color:var(--muted);font-size:10px}
.sizes button[aria-pressed="true"]{background:color-mix(in srgb,var(--ink) 8%,transparent);color:var(--ink)}
.terminal-options{display:flex;align-items:center;gap:10px;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.zoom{padding:4px 7px;border:1px solid var(--line);border-radius:4px;background:transparent;color:var(--muted);font-size:10px}
.terminal-shell{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#11151c;box-shadow:0 12px 36px #00000015}
.terminal{position:absolute;top:0;left:0;padding:14px 16px;margin:0;transform-origin:top left;white-space:pre;font:13px/19px ui-monospace,"SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;letter-spacing:0;tab-size:4;text-rendering:geometricPrecision;user-select:text;cursor:text}
.terminal-row{display:block;height:19px}
.terminal-row>span{display:inline-block;height:19px;line-height:19px;vertical-align:top}
.terminal-note{display:flex;gap:10px;justify-content:space-between;margin:8px 1px 0;color:var(--muted);font-size:10px}
.terminal-note .dot{color:var(--accent);margin-right:4px}
.consider{border-left:2px solid var(--accent);padding:0 0 0 12px;margin:22px 0 20px}
.consider-label{margin:0 0 4px;color:var(--muted);font-size:9px;letter-spacing:.13em;text-transform:uppercase}
.consider p:last-child{margin:0;font-size:12px;line-height:1.65;color:var(--ink)}
.try{border-top:1px solid var(--line);padding-top:17px}
.try-label{margin:0 0 7px;font-size:11px;color:var(--muted)}
.command-row{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--line);border-radius:6px;padding:8px 10px}
code{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.copy{border:0;background:transparent;padding:3px 4px;color:var(--muted);font-size:10px;white-space:nowrap}
.keys{margin:8px 0 0;color:var(--muted);font-size:10px;line-height:1.7}
kbd{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;border-bottom:1px solid var(--line);padding:0 2px;color:var(--ink)}
.preview-note{margin:10px 0 0;font-size:10px;line-height:1.65;color:var(--muted)}
.research{margin-top:18px;color:var(--muted);font-size:10px}
.research summary{cursor:pointer;list-style:none}
.research summary:before{content:"+ ";color:var(--accent)}
.research[open] summary:before{content:"− "}
.research p{margin:9px 0 0;line-height:1.7}
a{color:var(--ink);text-decoration-color:var(--line);text-underline-offset:3px}
.switcher{position:sticky;bottom:12px;z-index:4;display:flex;align-items:center;gap:7px;width:max-content;max-width:100%;margin:26px auto 0;padding:5px 8px;border:1px solid var(--line);border-radius:99px;background:var(--paper);box-shadow:0 6px 24px #00000024}
.switcher button{width:30px;height:29px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--muted);font-size:20px;line-height:1}
.switcher button:hover{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--ink)}
.switcher-label{min-width:142px;text-align:center;font-size:11px;white-space:nowrap}
.switcher-label span{color:var(--muted);margin-right:8px;font:9px ui-monospace,SFMono-Regular,Menlo,monospace}
@media(max-width:440px){body{padding:21px 13px 15px}.tabs{gap:0;margin-top:19px}.tab{font-size:10px;padding:7px 4px}.tab .num{font-size:8px}h2{font-size:22px}.description{font-size:12px;min-height:0}.terminal-options{gap:6px}.terminal-note{font-size:9px}.research{font-size:9px}}
@media(prefers-reduced-motion:no-preference){.tab,.sizes button{transition:background .15s,color .15s}}
</style>
</head>
<body>
<header>
  <div class="eyebrow">Inbox / layouts</div>
  <h1>Five layouts, one inbox.</h1>
  <p class="intro">Same inbox, same Kanagawa Wave colors. Five layouts with review labels visible in the queue, so you can focus on structure.</p>
</header>
<nav class="tabs" role="tablist" aria-label="Inbox layouts" id="tabs"></nav>
<main>
  <section aria-labelledby="designTitle">
    <div class="design-head"><div><p class="kicker" id="kicker"></p><h2 id="designTitle"></h2></div><div class="design-number" id="designNumber"></div></div>
    <p class="description" id="description"></p>
    <p class="strength" id="strength"></p>
    <div class="terminal-toolbar">
      <div class="sizes" role="group" aria-label="Terminal size">
        <button type="button" data-size="desktop">Desktop</button><button type="button" data-size="compact">Compact</button><button type="button" data-size="phone">Phone</button>
      </div>
      <div class="terminal-options"><span id="dimensions"></span><button class="zoom" type="button" id="zoom">Fit</button></div>
    </div>
    <div class="terminal-shell" id="terminalShell" aria-label="Native terminal rendering"><pre class="terminal" id="terminal"></pre></div>
    <div class="terminal-note"><span><span class="dot">●</span>Actual TUI rendering</span><span id="scaleLabel"></span></div>
    <aside class="consider"><p class="consider-label">A useful question</p><p id="consider"></p></aside>
  </section>
  <section class="try" aria-label="Try this design">
    <p class="try-label">Try the interactions in your terminal</p>
    <div class="command-row"><code id="command"></code><button class="copy" id="copyCommand" type="button">Copy</button></div>
    <p class="keys"><kbd>L</kbd> layout picker &nbsp; <kbd>[</kbd> <kbd>]</kbd> cycle layouts &nbsp; <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> views &nbsp; <kbd>j</kbd> <kbd>k</kbd> navigate &nbsp; <kbd>Enter</kbd> read &nbsp; <kbd>/</kbd> search</p>
    <p class="preview-note">This gallery is a read-only snapshot. All five terminal layouts share the same persistent inbox and real Open/Copy actions. Navigator is the default; choosing a layout in the app saves your preference on this host.</p>
  </section>
  <details class="research">
    <summary>Research and design references</summary>
    <p>Studied the compact review queues in <a href="https://www.gh-dash.dev/" target="_blank" rel="noreferrer">gh-dash</a>, the terminal reading experience in <a href="https://github.com/charmbracelet/glow" target="_blank" rel="noreferrer">Glow</a>, the pane hierarchy in <a href="https://yazi-rs.github.io/features/" target="_blank" rel="noreferrer">Yazi</a>, and the compact multi-pane workspace in <a href="https://github.com/jesseduffield/lazygit" target="_blank" rel="noreferrer">Lazygit</a>. All five use the same <a href="https://github.com/rebelot/kanagawa.nvim/blob/master/lua/kanagawa/colors.lua" target="_blank" rel="noreferrer">Kanagawa Wave palette</a>, keeping color constant while comparing layout.</p>
  </details>
</main>
<nav class="switcher" aria-label="Cycle inbox layouts"><button type="button" id="previous" aria-label="Previous layout">‹</button><div class="switcher-label" id="switcherLabel"></div><button type="button" id="next" aria-label="Next layout">›</button></nav>
<script id="frames" type="application/json">__FRAME_DATA__</script>
<script>
"use strict";
const DATA=JSON.parse(document.getElementById("frames").textContent);
const $=id=>document.getElementById(id);
let index=0,size="desktop",fit=true,activeFrame=null;
try{const params=new URLSearchParams(location.search);const found=DATA.designs.findIndex(d=>d.slug===params.get("variant"));if(found>=0)index=found;if(["desktop","compact","phone"].includes(params.get("size")))size=params.get("size");}catch(_error){}
DATA.designs.forEach((design,i)=>{const button=document.createElement("button");button.type="button";button.className="tab";button.setAttribute("role","tab");button.setAttribute("aria-controls","designTitle");const number=document.createElement("span");number.className="num";number.textContent=String(i+1).padStart(2,"0");button.append(number,document.createTextNode(design.name));button.addEventListener("click",()=>{index=i;render();});$("tabs").append(button);});
function updateURL(){try{const url=new URL(location.href);url.searchParams.set("variant",DATA.designs[index].slug);url.searchParams.set("size",size);history.replaceState(null,"",url);}catch(_error){}}
function resizeTerminal(){if(!activeFrame)return;const terminal=$("terminal"),shell=$("terminalShell");const measure=document.createElement("canvas").getContext("2d");measure.font=getComputedStyle(terminal).font;const cell=measure.measureText("M").width;const natural=activeFrame.width*cell+32;const scale=fit?Math.min(1,shell.clientWidth/natural):1;terminal.style.transform="scale("+scale+")";terminal.style.width=natural+"px";terminal.style.left=(fit?Math.max(0,(shell.clientWidth-natural*scale)/2):0)+"px";shell.style.height=Math.ceil((activeFrame.height*19+28)*scale)+"px";shell.style.overflowX=fit?"hidden":"auto";$("zoom").textContent=fit?"Fit":"1:1";$("zoom").setAttribute("aria-label",fit?"Show terminal at full size":"Fit terminal to the available width");$("scaleLabel").textContent=Math.round(scale*100)+"% · "+(fit?"fit to width":"scroll to explore");}
function render(){const design=DATA.designs[index];activeFrame=DATA.frames[design.slug][size];$("kicker").textContent=design.kicker;$("designTitle").textContent=design.name;$("designNumber").textContent=String(index+1).padStart(2,"0")+" / 05";$("description").textContent=design.description;$("strength").textContent=design.strength;$("consider").textContent=design.consider;$("dimensions").textContent=activeFrame.width+" × "+activeFrame.height;$("command").textContent="review-inbox --layout "+design.slug;$("copyCommand").textContent="Copy";$("switcherLabel").replaceChildren();const number=document.createElement("span");number.textContent=(index+1)+" / 5";$("switcherLabel").append(number,document.createTextNode(design.name));document.querySelectorAll(".tab").forEach((b,i)=>{b.setAttribute("aria-selected",String(i===index));b.tabIndex=i===index?0:-1;});document.querySelectorAll("[data-size]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.size===size)));const fragment=document.createDocumentFragment();activeFrame.rows.forEach(runs=>{const row=document.createElement("span");row.className="terminal-row";runs.forEach(([styleID,text])=>{const style=DATA.styles[styleID],span=document.createElement("span");span.textContent=text;span.style.color=style[0];span.style.backgroundColor=style[1];span.style.fontWeight=style[2]?"700":"400";row.append(span);});fragment.append(row);});$("terminal").replaceChildren(fragment);const base=DATA.styles[activeFrame.rows[0][0][0]][1];$("terminalShell").style.backgroundColor=base;$("terminal").style.backgroundColor=base;updateURL();resizeTerminal();}
function cycle(delta){index=(index+delta+DATA.designs.length)%DATA.designs.length;render();}
$("previous").addEventListener("click",()=>cycle(-1));$("next").addEventListener("click",()=>cycle(1));$("zoom").addEventListener("click",()=>{fit=!fit;resizeTerminal();});
document.querySelectorAll("[data-size]").forEach(b=>b.addEventListener("click",()=>{size=b.dataset.size;render();}));
$("copyCommand").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("command").textContent);$("copyCommand").textContent="Copied";}catch(_error){const range=document.createRange();range.selectNodeContents($("command"));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);$("copyCommand").textContent="Selected";}});
document.addEventListener("keydown",event=>{if(event.target.matches("input,textarea,[contenteditable='true']"))return;if(event.key==="ArrowLeft"){event.preventDefault();cycle(-1);}else if(event.key==="ArrowRight"){event.preventDefault();cycle(1);}else if(/^[1-5]$/.test(event.key)){event.preventDefault();index=Number(event.key)-1;render();}});
if(typeof ResizeObserver!=="undefined")new ResizeObserver(resizeTerminal).observe($("terminalShell"));else window.addEventListener("resize",resizeTerminal);
render();
</script>
</body>
</html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="destination HTML file")
    parser.add_argument(
        "--command",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "bin" / "review-inbox",
        help="review-inbox executable to snapshot",
    )
    args = parser.parse_args()
    data = json.dumps(capture_frames(args.command), separators=(",", ":"), ensure_ascii=False)
    # The JSON is data, never markup. Escaping '<' also prevents user content
    # containing '</script>' from terminating the embedded data element.
    data = data.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    page = PAGE.replace("__FRAME_DATA__", data)
    output = args.output or Path.home() / ".moshi" / "visuals" / f"inbox-layouts-{uuid.uuid4().hex[:8]}.html"
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = page.encode("utf-8")
    if len(payload) >= 512 * 1024:
        raise SystemExit(f"Gallery exceeds Moshi's 512 KB limit: {len(payload)} bytes")
    output.write_bytes(payload)
    print(output)
    print(f"{len(payload):,} bytes; 5 layouts × 3 terminal sizes")


if __name__ == "__main__":
    main()
