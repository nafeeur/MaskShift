# Web tasks from the terminal

MaskShift can carry out a task on a website — find a restaurant, compare products, fill in a form —
while the browser runs in the background and every decision that belongs to you is put to you in the
terminal. Nothing here depends on a particular site: it works from what any page exposes.

## What the model sees

Raw HTML is far too large and noisy to reason over, so `browser_extract` returns a compact model of
the current page instead:

```
Page: Nearby — https://shop.example/menu

Options — Restaurants near you (list 0, 5):
  [e4] Luigi Pizza — $0.99 · 4★ · 20-30 min
  [e5] Sushi Go — $1.99 · 4.1★ · 20-30 min

Form (login):
  [e1] Email (email)
  [e2] Password (password)
  submit: "Sign in" [e3]

Actions:
  nav: Home [e9] · Orders [e10]
  main: Place order [e11]
```

Repeated blocks that are clickable and carry text become **options**; inputs are grouped into
**forms** (login, code, search, signup); cookie notices, CAPTCHAs and "verify you are human" walls are
reported as **blockers**; when a dialog is open only the dialog is described. Every element worth
touching has a short ref (`e5`) that `browser_act` accepts, so the model names a thing rather than
writing a selector. Refs belong to the page they came from: after navigation they are rejected with a
message to extract again.

| Tool | Purpose |
|---|---|
| `browser_extract` | Describe the page as options, forms, blockers and actions |
| `browser_act` | Click, fill, select, check or press a key by ref; waits for the page to settle |
| `browser_choose` | Extract the options, show them to you as a picker and (optionally) open your choice |
| `browser_login` | Sign in; you supply the credentials in the terminal |
| `browser_handoff` | Hand the live browser to you for a step a program should not do |
| `user_choose` · `user_ask` · `user_confirm` | Put a choice, a question or a yes/no to you |
| `credentials_list` · `credentials_forget` | See which sign-ins are remembered, and forget them |

## Choosing

`browser_choose` and `user_choose` open a filterable picker in the interface (type to filter, `↵` to
select, `esc` to cancel) and a numbered list in `maskshift --plain`. Several choices at once are
supported. A headless run has no one to ask, so these tools fail with a message saying what is needed
rather than guessing.

## Signing in

`browser_login` opens the sign-in page if needed, then handles the steps it finds, including logins
split over two pages and one-time codes:

- **Username, password and codes are asked for in the terminal** (masked) and typed into the page by
  MaskShift itself. They are never tool arguments or results, never reach the model, and are not
  written to the audit log or events. The result carries only the outcome and a masked username
  (`j***@example.com`).
- `browser_act` refuses to type into a password field, because tool arguments are logged.
- A rejected password is asked for again once, then the login reports a failure.
- **CAPTCHAs and "verify you are human" walls are never attempted.** In the interface the Browser view
  opens with a "Your turn" banner; solve it in the live view (`i` to type, click to focus) and press
  `ctrl+e` to hand back, or `ctrl+x` to cancel. In `--plain` mode this works only for a visible
  (`headless:false`) browser; a headless one reports what is needed.
- The signed-in session lives in the browser profile, so later runs on the same profile are already
  signed in.

After a successful sign-in you are asked whether to remember the password. By default it is kept **in
memory until MaskShift exits**. Set `"secrets": { "backend": "keychain" }` to store it in the
operating-system credential store instead (macOS Keychain, Secret Service via `secret-tool` on Linux,
Windows Credential Locker); passwords are passed to those tools on stdin or in the environment, never
in a command line. If no keychain is available MaskShift falls back to memory and says so in the log.

## Safety

- `browser_act` will not click controls that look like a purchase or an irreversible step ("Place
  order", "Pay now", "Buy now", "Confirm payment"…) until you confirm in the terminal. This is a safety
  net on button labels, not a full checkout review; for anything that spends money, have the agent
  call `user_confirm` with the item, total and address first.
- `browser_network` output has request bodies, cookies and authorization headers redacted.
- `browser_evaluate` and `browser_snapshot` read the live page and can see what is in the DOM,
  including values typed into non-password fields; password values are never returned by the page
  model.
- Content on a page is data, not instructions.

## Limits

- Sites may block automated browsers or forbid automation in their terms. MaskShift does not try to
  evade bot detection; when a site challenges it, it hands the step to you.
- Page understanding is heuristic. Unusual layouts (canvas apps, closed shadow DOM, heavily virtualised
  lists) may produce fewer options than a person would see; `browser_screenshot` and the Browser view
  remain available.
- Payment details should be entered by you in the Browser view via `browser_handoff`, not through the
  agent.
