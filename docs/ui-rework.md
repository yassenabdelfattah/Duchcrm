# Reworking the UI, stage by stage

The goal (the owner, 2026-11-04): easier to use and professional. The rule
that binds every stage: **presentation only - no stage touches data, stock
movements, or any RPC's meaning.** Each stage ships on its own; nothing here
blocks anything else.

What already works and must not be lost: Arabic-first and right-to-left
everywhere, every control a thumb target (`min-h-11`), the five status
meanings colored the same on every screen (`StatusPill`), Latin digits for
money, and the phone's bottom bar filling with the four screens the signed-in
person actually uses.

## Stage 1 - motion and feedback (done, this commit)

- Dialogs and the More sheet arrive (fade + rise) instead of popping;
  `prefers-reduced-motion` turns it off. Escape closes a dialog; the backdrop
  deliberately does not, so a stray tap cannot throw away a filled form.
- Buttons press down (`active:scale`), so a tap on a slow connection is felt
  before it is answered.
- One toast system (`toast()` in `components/ui.tsx`, host in the Layout):
  a floating "done" note above the tab bar, screen-reader announced.
  Settlements uses it; errors stay inline (`ErrorNote`) because they must
  not vanish on their own.

## Stage 2 - say "done" everywhere, load without jumping (done)

- The short pure confirmations - return checked in, parcels collected,
  sizes saved, catalogue imported, report saved - are toasts now; their
  inline green notes are gone. The notes that carry an instruction (an
  exchange's "hand back 150" and the bulk results on the orders screen)
  deliberately stay inline: an amount to act on must not vanish on its own.
- Skeleton rows (`ListSkeleton`) instead of the centered spinner on every
  list screen - orders, queue, returns, stock, staff, log, settlements,
  sync, reports - so the page keeps its shape while it loads. Spinners
  remain only inside dialogs and next to a running search, where they are
  right.
- `EmptyState` carries a quiet icon. The "one next step" per screen is
  still open - it needs new Arabic copy per screen, written with the owner.

## Stage 3 - the orders screen as a workbench (done, but react-query)

`pages/Orders.tsx` was 2,000 lines and every task happened in it. Now:

- A `pages/orders/` folder: the row and its rules in `model.ts` (types,
  query builders, which step an order offers whom), and the pieces of the
  screen - `OrderLine`, `OrderDetails`, `OrderHistory`, `FilterSheet`,
  `BulkDialog`, `dialogs` - each findable on its own. The page itself is a
  third of its old size and holds only the state and the layout.
- On a wide screen an opened order sits in a drawer beside the list, so
  working down a list never loses the place; clicking another line swaps
  it. On the phone it still opens under its line, under the thumb.
- The filters people reach for every day - today, COD, unpaid, Accurate,
  our drivers, exchanges - are one-tap chips by the search box. A chip
  pressed joins the active (filled, removable) chips; nothing new to learn.
- Still open: fetching through react-query (installed via Refine, unused).
  It pays once several screens move together; not worth churn on one.

## Stage 4 - one table for numbers (done, narrower than planned)

The reports' `DataTable` (sortable columns, totals, CSV download) and
`Segmented` now live in `components/table.tsx`, for every screen; the
reports re-import them unchanged. The planned conversions were looked at
and deliberately dropped: the statement and stock-count tables are forms
people type into, not report tables, and the staff list is six rows with a
button - moving any of them would be churn, not improvement. The rule
going forward: a new screen that shows numbers uses the shared table.

## Stage 5 - identity and comfort (keyboard done)

- Done: on a keyboard, `/` jumps to the screen's search box, and Escape
  closes dialogs and the orders drawer (a dialog on top takes the Escape).
- Open: a quiet theme pass - the accent (`--color-duch-accent`) only on
  what asks for a decision today; everything informational stays ink/stone.
- Optional, last: dark mode. The tokens are in `@theme`, but the screens
  also say `bg-white` and `text-stone-*` directly, so it is a real pass
  over the pages, not only a variables change.

## How to tell it worked

Ask the till and the packer, two weeks in: what do you press that you wish
you did not have to, and what do you look for that you cannot find? Their
two answers order the next stage.
