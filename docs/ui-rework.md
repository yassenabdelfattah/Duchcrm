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

## Stage 2 - say "done" everywhere, load without jumping

- Adopt `toast()` after every successful action: sale recorded, order
  shipped, return checked in, stock counted, sizes saved. Today some screens
  say nothing and the only sign is the list refreshing.
- Skeleton rows instead of the centered spinner on the list screens (orders,
  stock, reports), so the page keeps its shape while it loads - the reports
  hook already keeps old data for this reason; the lists should look the same.
- `EmptyState` gets an icon and one next step ("no orders today - record a
  sale"), instead of a bare sentence.

## Stage 3 - the orders screen as a workbench

`pages/Orders.tsx` is 2,000 lines and every task happens in it. Split by
what people do, not by code size:

- A `pages/orders/` folder: list, filter bar, order drawer, bulk bar - the
  same screen, in parts a new reader can find.
- On desktop, opening an order slides a drawer beside the list instead of
  jumping; the list keeps the scroll position. On the phone it stays a page.
- Saved filters as chips over the list (today's COD, with Accurate, unpaid),
  like the saved reports: press, not re-pick, re-type.
- Move fetching to react-query (installed through Refine, unused): retries,
  caching and "is it stale" solved once instead of 77 hand-rolled effects.

## Stage 4 - one table on every screen

The reports' `DataTable` (sticky totals, CSV download, column meanings) is
the best table in the app and only the reports use it. Lift it to
`components/`, give it sortable headers and sticky first column, and move
the hand-rolled tables (stock, staff, log) onto it, one screen a commit.

## Stage 5 - identity and comfort

- A quiet theme pass: the accent (`--color-duch-accent`) appears only on
  what asks for a decision today; everything informational stays ink/stone.
- Keyboard on desktop: `/` focuses search, Escape already closes.
- Optional, after everything above: dark mode behind a token pass -
  `styles.css` already keeps every color in `@theme`, so it is a variables
  change, not a redesign.

## How to tell it worked

Ask the till and the packer, two weeks in: what do you press that you wish
you did not have to, and what do you look for that you cannot find? Their
two answers order the next stage.
