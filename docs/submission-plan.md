# Dev3Pack submission plan

This is the checklist for 28 and 29 November 2026. It comes from comparing our repository with a strong competing entry, and from the scoring of a hackathon the owner won on 28 November: half the marks there were pass/fail checks, the rest was graded from the code, the written answer and on-chain checks, and judges only reviewed the top few.
The rule behind every step: a first-pass grader only scores what it can find on the first screen.

## 1. Confirm the deadline hour

**Why:** the FAQ says Sunday 29 November, with the exact UTC hour on the dashboard.

**Do:**
- [ ] Read the deadline hour on the dashboard.
- [ ] Fill `deadline` in `event.toml`.
- [ ] Work back from it: the video is recorded N hours before, and submission is at least two hours before.

**Done when:** `event.toml` has the deadline with a UTC offset.

## 2. Merge the README rewrite

**Why:** the old README opened as an internal design package and said the program was not deployed.

**Do:**
- [ ] Read the diff on branch `docs/submission-readme`.
- [ ] Push only when the demo rehearsal's gate lock is free, because the pre-push gate resets the local Supabase the rehearsal uses.
- [ ] Open the pull request and merge on green.

**Done when:** the public repository's first screen shows the pitch, the program address and the limits.

## 3. Add the start-to-finish transaction table

**Why:** the strongest competing README puts one explorer link per step of its story right under the pitch. Ours only has seed transactions.

**Do:**
- [ ] After one clean rehearsal run, collect the devnet signature for each step: issue the lot; pledge request and lock; advance recorded; second lender's refused pledge; handover (both signatures); refused driver; border observation; arrival; release intent, payment confirmed, buyer accepts; loading; duplicate intake refused.
- [ ] A refusal that fails in simulation has no transaction. Say so and name the error. Do not fake a link.
- [ ] Add a `## Proof: one run on devnet` section directly under "In 30 seconds", with the run date and instance id.
- [ ] Remove the matching bullet from Limits.

**Done when:** every link opens on the explorer logged out and shows Success (or the named failure).

## 4. Record the video, under 3:00

**Why:** a video over 3:00 is disqualified. The FAQ asks for the product in action, not slides.

**Do:**
- [ ] Follow the golden path table in `DEMO.md`.
- [ ] Keep both refusals (second lender, refused driver) in.
- [ ] Say "devnet, synthetic data" once aloud.
- [ ] Show no keys, codes or seed phrases on screen.
- [ ] Target 2:50.
- [ ] Upload as public or unlisted.
- [ ] Open the link in a logged-out private window.
- [ ] Put the link in the README facts table.

**Done when:** the link plays logged out and the player shows under 3:00.

## 5. Host the read-only judge page

**Why:** `RUBRIC.md` lists a live demo link among the requirements for Best App Overall, and stage 2 includes "live demo verification". A judge cannot play four organisations on two phones, so today they can only watch us. The strongest competing entry lets anyone open a link and see real devnet steps in about 90 seconds. This page is our answer to that, and it is the step most likely to change the result.

**What it is:** one public URL. A judge signs in as a read-only role, with no wallet and no signing authority, and sees one real devnet run from issue to loading. Each step shows who signed, its state as the program confirmed it, and a link to its transaction. The refusals are on the page too, each with its error name.

**Do:**
- [ ] Decide the hosting today. The page needs the web app and the read model reachable from the internet, so it needs the AWS account and region, and a hosted Supabase. Both are still open owner decisions.
- [ ] Add the page to the web design document first, in its own pull request: the route, the judge role, what each step row shows, and the visual reference. Build nothing before that is agreed.
- [ ] Give the judge role read access only: no command can be sent from it, and the access rules let it read the one judged instance and nothing else.
- [ ] Run one clean rehearsal on a fresh instance and keep it as the judged run. Never reset that instance afterwards. The same run supplies the transaction table in step 3.
- [ ] Show only what the chain confirms. A step with no confirmed transaction is not shown as done. A refusal that failed in simulation has no transaction: name the error and say so.
- [ ] Label the page devnet and synthetic, and show the program address.
- [ ] Put the sign-in details a judge needs in the README and the submission form, with nothing secret in them.
- [ ] Put the URL in `event.toml` `demo_url`, the README's "See it" line and the submission form.
- [ ] Remove the "no hosted demo" bullet from the README's Limits.
- [ ] If hosting cannot be ready before the video is recorded, say so in Limits and submit the video and the transaction table as the proof. Do not submit a link that depends on a laptop staying on.

**Done when:** with every local service stopped, the URL opens on a phone outside the home network, a judge sign-in shows the run, and every step's link opens on the explorer.

## 6. Write `docs/dev3pack-submission.md`

**Why:** the form has five steps (project: name, one-liner, optional category, contract address, hub, description; images; links and video; team; review). Pasting from a checked file avoids last-minute wording.

**Do:**
- [ ] Name.
- [ ] One-liner (draft): "A shared Solana record of who holds a mineral lot and what is pledged against it, signed by every party on the way to port."
- [ ] Category: Best App Overall on Solana.
- [ ] Contract address: `jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3` (devnet).
- [ ] Hub and team: the owner fills these in. Never guess.
- [ ] Description: problem, what we built, why Solana (reuse the README text), limits.
- [ ] Links: repository, video, live demo.
- [ ] Decide whether to opt into the South Africa local track (the tracks page lists no extra requirements).
- [ ] Do not claim the Solana Mobile track: it needs a dApp Store submission we have not made.

**Done when:** every field in the form is pasted from the file and the file has no empty field.

## 7. Screenshots

**Do:**
- [ ] Web at 1440: queue, lot dossier, the refused pledge, release.
- [ ] Field app on a phone: issue, handover signed, refused driver.
- [ ] Add four to the README under "What it does" and upload them to the form's Images step.
- [ ] Every shot shows the synthetic label.

**Done when:** the README renders them on GitHub.

## 8. Fill in `DEFENSE.md`

**Why:** its five answers are empty, and stage 2 is where judges decide if it is real.

**Do:**
- [ ] Answer each from the README's Limits and facts table: real versus mocked; try your own input; why these tools; how it was checked; what was cut.

**Done when:** no "**Answer:**" line is blank.

## 9. Bring stale files up to date

**Do:**
- [ ] `RUBRIC.md` gaps table (it still says not deployed and no LICENSE).
- [ ] `event.toml`: `demo_url`, `deadline`, `[checks]`.
- [ ] `docs/reuse-manifest.md`: add a section for work merged during the window, matching the README table.
- [ ] Replace the "over 1,200" TypeScript test figure in the README with the exact count from the latest green CI run.

**Done when:** none of these files contradicts the README.

## 10. Final checks, then submit

**Do:**
- [ ] Open the repository logged out.
- [ ] Click every explorer link.
- [ ] Run the README's setup commands on a fresh clone.
- [ ] Confirm the secret scan is green on `main`.
- [ ] Confirm the video link is public.
- [ ] Submit with at least two hours to spare.
- [ ] Screenshot the confirmation.

**Done when:** the confirmation screenshot is saved.

## Not doing

- Solana Mobile track (needs a dApp Store submission).
- Any new program feature after the video is recorded.
- Mainnet.
