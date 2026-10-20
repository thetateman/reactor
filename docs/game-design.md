# Reactor: game design

Working design doc. It records what's decided, what's proposed, and what's still open. Last updated 2026-10-16.

Labels used below:
- **Decided:** agreed, build it this way.
- **Proposed:** a suggestion, not yet agreed.
- **Open:** needs a decision.

## Vision

A co-op escape game for a group of friends. Players load into a procedurally generated, melted-down nuclear facility laid out as a maze, and have to work together to get everyone out.

The design goal is **collaboration through different roles**. Players should need to split up, take on separate jobs, and share what they know to escape.

- **Decided:** all players are on one team. Nobody is working against the group.
- **Decided:** desktop browsers only, played among friends. Players reading game data in their browser's developer tools is acceptable, so there's no need to hide information from clients or prevent cheating.

## What exists today

| Area | State |
|---|---|
| Lobbies | Create a game or join one with a 4-letter code or invite link. The host starts the game. Players rejoin automatically after a refresh or disconnect. |
| Maze levels | Generated from a seed. Each map has a 17×11 control room in the center, 12 chambers (8–11 tiles across), and 2-tile-wide maze passages with dead ends between them. Every room entrance has a door. The exit hatch sits inside an extraction zone in an outer chamber, at least 120 steps from spawn. |
| Reactor | A solid 3×3 reactor in the middle of the control room, with a temperature dial, an Insert/Extract menu, power on/off, and an instant meltdown at 100%. See "Reactor version 1" below. |
| Escape | E on the hatch ends the level. Every standing player in the extraction zone escapes. A results screen shows the time, who escaped with their remaining HP, and who was left behind. A meltdown ends the level too, with its own results screen. |
| Health | Each player has 10 HP. A player at 0 HP is down: they can't move and enemies ignore them. There's no revive yet. |
| Enemies | One spawns every 5 seconds on average, in a room with no player in it, up to 30 at once. Enemies have 3 HP, chase players they can see, drain 1 HP per second on contact, and can't open doors. |
| Combat | Left-click fires toward the cursor. Players start with no ammo and carry at most 20 rounds. A bottomless ammo stack sits in the control room. Bullets stop at walls and closed doors. |
| Interaction | E uses whatever is nearest, in this priority order: the hatch, then the reactor, then ammo, then the nearest door. |
| Lighting | The level is dark. Rooms and hallways light up while the reactor makes power. Each player has a small circle of light and a flashlight (right-click) with 10 minutes of battery. See "Lighting, flashlights and minimap" below. |
| Minimap | M toggles a small map that follows the player and shows only what they've explored, plus teammates. |
| Audio | Gunshots, door open and close, ammo pickup, and looping background music. |
| Testing aids | Shift+M shows the whole level, with the exit, enemies and every door, until the control-room computer map exists. |

Level 1 is tuned so a group exploring **without** a map takes about 5 minutes. With the whole map visible it takes under a minute.

## Shelved

- **Hidden teams and PvP (shelved 2026-10-16).** The original concept split players into two secret teams that won by escaping or by incapacitating the other team. It's set aside in favor of pure co-op and could come back as a separate mode.
- **Accumulating radiation (status open).** In the original concept, players built up radiation at an accelerating rate the longer they stayed. See the open questions.

## The reactor and power (decided concept, details proposed)

**Decided** (from the 2026-10-16 discussion):

- A fission reactor sits in the central room, which is now called the **control room** (the code still calls it the hub or spawn room). It powers the facility.
- While it's generating power, players can use:
  - **lights** across the map, which let players see more of it;
  - a **terminal** in the control room with a map of the whole level;
  - a **charging station** for flashlight and walkie-talkie batteries.
- The reactor has to be managed. Every couple of minutes someone has to **insert or extract a fuel rod**:
  - too little activity and it **powers off**;
  - too much and it **melts down, killing everyone on the map**.
- The intended play pattern:
  - one or more players stay in the control room running the reactor and reading the terminal;
  - the others search the maze for the exit;
  - the two groups coordinate over **walkie-talkies**.

### Why it works

The two roles hold different information:

- **The operator** has the map but can't see what's in the corridors.
- **The explorers** see the corridors but have no map.

Neither group can do well alone, so they have to talk. The same pattern drives Lethal Company, where one player stays on the ship terminal guiding the others, and Keep Talking and Nobody Explodes.

### Design risks

1. **The operator could get bored.** If the job is "press E every two minutes", the operator mostly waits. The reactor should need active attention, or the operator should have other jobs that matter to the explorers. Ideas below.
2. **The operator still needs to escape.** Whoever stays behind has to reach the exit at the end, alone, with no one at the reactor. That needs a deliberate endgame (see the open questions). It could be the best moment of a level.
3. **Fog of war is now a requirement.** Lights, flashlights and the terminal map only matter if players *can't* see the whole level. A vision and lighting system moves from "later" to a prerequisite, and the M minimap goes away.
4. **The walkie-talkies imply in-game voice chat**, which is the largest technical piece on this list. A group already on Discord can test everything else without it.

### Reactor version 1: one fuel rod (built 2026-10-16)

The reactor gets built and tuned on its own before anything else. The goal is to get the mechanic right; graphics can stay rough. All of the following is decided and implemented. The numbers are first values the user expects to tweak; they live in `shared/constants.js`.

**How it works:**

- **Look:** the reactor is a glowing blue 3×3-tile block in the middle of the control room. Its glow is constant, the same at any temperature (decided 2026-10-19).
- **Solid:** players, enemies and bullets can't pass through it.
- **Dial:** a temperature dial sits on the reactor's face. It's drawn there rather than above the block so it never covers players standing next to it.
  - **It's discovered by using the reactor** (decided 2026-10-19). At first everyone sees only a glowing blue square. Once any player presses Insert or Extract in the reactor's menu, the dial shows on the reactor for everyone for the rest of the level. The menu's own larger dial always shows.
  - Left is **blue**: too cool, no power.
  - The center/top is **green**: stable, producing power.
  - Right is **red**: overheating, still producing power.
- **Start:** every level begins completely cold, with the needle all the way left and the rod out.
- **The menu:**
  - E next to the reactor opens a menu with a larger dial, a status line, and **Insert rod** and **Extract rod** buttons. Only the one that applies is enabled.
  - The menu stops the player moving and shooting.
  - E or Esc closes it.
  - The server accepts a button press only from a player within reach who isn't down.
- **The fuel rod:** one rod, reused forever.
- **Meltdown:** when the needle reaches the far right, everyone on the map dies instantly. The level ends, and the results screen says **Meltdown**. There's no warning yet; one may come later.
- **What power does:** it turns on the room lights (see "Lighting, flashlights and minimap"), and everyone's HUD shows a power on/off light. (Until lighting existed, the M minimap stood in, working only with power.)
- **Control room layout:** players spawn on the ring of tiles touching the reactor. The ammo stack stays at least 3 tiles away, so E at the stack always means "take ammo".
- **E priority:** hatch, then reactor, then ammo, then door.

**Numbers:**

| | Value |
|---|---|
| Temperature scale | 0–100% of the dial |
| Blue, no power | 0–30% |
| Green, power | 30–70% |
| Red, overheating, still powered | 70–100% |
| Meltdown | instant at 100% |
| Heating, rod in | 0 → 100% in 4 minutes (about 0.42% per second) |
| Cooling, rod out | the same speed: 100 → 0% in 4 minutes |

What those numbers give:

| Event | Time |
|---|---|
| First insert to power on (0 → 30%) | 72 seconds |
| Crossing green either way (30 ↔ 70%) | 96 seconds |
| Leaving green on the hot side to meltdown | 72 seconds |
| Holding green | one action roughly every 1½ minutes |

**Ways to make it harder later, without changing the controls:**

- a narrower green band;
- faster heating in later levels;
- thermal lag, where the temperature keeps climbing for a few seconds after extracting;
- random drift in the heating rate;
- enemies getting into the control room;
- a warning as the needle nears meltdown, such as an alarm or a red flash.

### Lighting, flashlights and minimap (built 2026-10-17)

These make the reactor matter: without power the level is dark, apart from what each player can light themselves. All of the following is decided and implemented; the numbers are first values, meant for tuning.

**Lighting**

- **Lit rooms** look as they did before lighting existed: fully visible, walls included, **from anywhere on screen, regardless of line of sight** (changed 2026-10-17 after playtesting; it had cast a shadow behind the reactor). Each room has its own light. For now, all of them are on whenever the reactor makes power (30% and up, including the red zone). Later levels may have the operator route power to specific rooms, and the server already tracks lights room by room.
- **Hallways** (the maze passages) light up with power too, and are just as fully visible as lit rooms (changed 2026-10-17; they were originally always dark). They share one light, separate from the rooms', so they could later be powered on their own or by sector. With everything lit, power reveals all of the level on screen, enemies included, and flashlights matter only while the power is off.
- **What you see outside lit rooms:** your own light, flashlight beams and glows only show where they're in your line of sight. Walls, closed doors and the reactor block sight.
- **Personal light:** in the dark, each player sees a small circle around them. It's fully lit within 0.8 tiles and fades out by 2.2.
- **Glowing objects:**
  - The **reactor** always glows, lighting a 3.5-tile radius around it whatever its temperature. Like a lit room, the glow is visible from anywhere on screen, line of sight or not (decided 2026-10-19), so it shows on every side of the reactor and anything in it can be seen. Once any side of it is in sight, the whole block (and its dial, once revealed) is shown.
  - The **exit hatch** glows faintly, within about 1.6 tiles.
- **Outside your sight** is pitch black. The minimap does the remembering.
- **Enemies and teammates** in the dark can't be seen.
  - Teammates' **name tags always show**, so the group can find each other.
  - Health bars only show for players and enemies you can actually see.

**Flashlights**

- Right-click switches your flashlight on or off. It lights a 60° cone toward the mouse that reaches about 10 tiles and fades toward the end.
- **Battery:** 10 minutes of use, draining only while on. The HUD shows the time left. A flat battery switches the flashlight off for good, until charging exists.
- Every flashlight **starts off**, resets each level, and switches off when its owner goes down.
- **Teammates' beams** are visible wherever you can see them. Each beam is cut off by walls as seen from its owner.

**Minimap**

- Always available, with M to show or hide it. It no longer needs power.
- It shows a **34×22-tile window** (twice the control room in each direction) centered on you, north up. It takes about the same space on screen as the old one, at 7 px per tile.
- It shows only **tiles you've seen lit** in your line of sight: floors, walls, the reactor, and doors (without whether they're open). **A room you've been inside is shown in full whenever its light is on**, even if you were only there in the dark. Seeing a lit room from outside doesn't put it on your minimap. It also shows **teammates' positions**; teammates outside the window simply aren't shown.
- It never shows enemies, the exit hatch or pickups.
- What you've explored is kept in the browser, so it survives a page refresh mid-level.
- The full-level map that used to be on M stays available on **Shift+M**, for testing.

**To decide later**

- Hallway floors are a darker color than room floors, so flashlight beams in hallways (with the power off) are subtle. The colors could be brightened if they're hard to read.

### Ideas for later reactor versions

- Rods burn down over time, so output slowly falls and fresh rods are needed.
- After losing power, the reactor scrams (shuts down) and needs a cold-start procedure to come back.
- An alarm sounds across the facility while the reactor is overheating.

### Proposed extra operator jobs

Pick a few, not all:

- **Remote doors:** open or close any door from the terminal, to seal enemies in or let explorers through.
- **Light routing:** limited power means only some sectors can be lit at once, and the operator chooses which.
- **Spotting:** the terminal shows enemies near explorers, or there are cameras in some rooms.
- **Supply:** the operator charges batteries and hands them out, or keeps the ammo stack stocked.
- **Defense:** enemies sometimes try to get into the control room, so the operator has to fight while keeping the reactor stable.

### Proposed role links

- **Fuel rods come from the maze.** Start with a small stock in the control room. Further rods have to be found by explorers and carried back, so the explorers keep the operator supplied and the roles depend on each other.
- **Explorers need the operator's map to find their way,** and **the operator needs explorers' reports** to know what's actually down each corridor: enemies, locked doors, items.

## Supporting systems needed

| System | What it involves | Size |
|---|---|---|
| Vision and lighting | Built (see "Lighting, flashlights and minimap"). Possible later additions: routing power to specific rooms, enemies reacting to light. | Done (v1) |
| Maps | **Decided direction (2026-10-16):** two maps. Every player always has a **small minimap** that shows only what fog of war has revealed, whether or not there's power. The control-room **computer** has a much more useful map of the whole level, usable only while the facility has power. It shows rooms, doors and perhaps the exit (open question), and possibly explorer positions and enemies. The small minimap is built; the computer map is next. | Medium |
| Reactor | Version 1 is built (see above). Later versions might add rod burn-down, scram and restart, and alarms. | Done (v1) |
| Items and inventory | Flashlight, walkie-talkie, batteries, fuel rods and ammo. A few inventory slots, item pickups placed around the map, a charging station and a HUD. | Medium–large |
| Voice chat | A walkie-talkie works as a team-wide radio while it has battery. Without one, players are heard only nearby (the proximity voice planned from the start). Browser-to-browser audio with the existing server connecting the players. | Large |

## Proposed build order

1. **Reactor version 1: built 2026-10-16, now being playtested and tuned.** The single fuel rod, temperature dial, Insert/Extract menu, power on/off, and meltdown. See "Reactor version 1" above.
2. **Lighting, flashlights and minimap: built 2026-10-17.** See "Lighting, flashlights and minimap" above.
3. **Control-room computer map**, working only while the facility has power.
4. **Items and batteries.** Inventory, flashlight and walkie batteries, the charging station, and fuel rods placed in the maze.
5. **Operator endgame**, whichever version is chosen.
6. **Voice:** walkie-talkie radio and proximity voice. Use Discord until then.

Each step can be played and tested before the next one starts.

## Open questions

1. **Fuel rods:** a stockpile in the control room, found in the maze, or both?
2. **Operator jobs:** which of the extra operator jobs, if any, appeal?
3. **The operator's escape:** how does the operator get out? Options:
   - set the reactor to coast safely for a few minutes and run for it;
   - scram it, then cross the dark maze with explorers guiding over the radio;
   - start a deliberate overload countdown and race the meltdown out.

   And must everyone escape for a "win"?
4. **The terminal map:** does it show the exit, or only the layout so explorers still have to find it? Does it show explorers' positions or enemies?
5. **Voice:** build in-game walkie-talkie and proximity voice soon, or use Discord until the rest is solid?
6. **Losing power:** besides lights, terminal and charging, does anything else stop, such as doors or the hatch? Can a scrammed reactor be restarted, and how?
7. **Group size:** what's the expected range? Should one player be able to play alone, filling both roles with a more forgiving reactor?
8. **Radiation:** keep accumulating radiation, tie it to reactor heat (for example, leaks while it runs hot), or drop it?
