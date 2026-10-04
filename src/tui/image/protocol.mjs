// Which inline-image mechanism this terminal supports, best first.
//
//   kitty-unicode  Kitty graphics with Unicode placeholders — Kitty, Ghostty. The picture is
//                  drawn as text, so it cannot outlive a repaint, pane switch or modal
//   kitty      Classic APC placement — WezTerm, and anything forced with MASKSHIFT_IMAGE=kitty
//   iterm      OSC 1337 inline images — iTerm2
//   halfblock  Unicode ▀ + 24-bit colour, two source pixels per cell — the
//              universal fallback: needs nothing from the terminal beyond
//              the truecolor support MaskShift already detects for its UI
//
// Detection mirrors detectDepth()'s in theme.mjs: sniff the handful of env
// vars a terminal actually sets, rather than querying the terminal itself
// (which would mean blocking on a reply mid-render).
export function detectImageProtocol(env = process.env) {
  if (env.MASKSHIFT_IMAGE === 'off') return 'none';
  if (env.MASKSHIFT_IMAGE === 'ascii' || env.MASKSHIFT_IMAGE === 'halfblock') return 'halfblock';
  if (env.MASKSHIFT_IMAGE === 'kitty') return 'kitty';
  if (env.MASKSHIFT_IMAGE === 'kitty-unicode') return 'kitty-unicode';
  if (env.MASKSHIFT_IMAGE === 'iterm') return 'iterm';

  const term = env.TERM || '';
  const termProgram = env.TERM_PROGRAM || '';
  // Inside tmux or screen, graphics escapes only reach the terminal through passthrough, which is
  // off by default and leaves ghosts behind when windows switch, so the text-only renderer is
  // used unless the person forces a protocol with MASKSHIFT_IMAGE.
  if (env.TMUX || /^(screen|tmux)/.test(term)) return 'halfblock';
  if (termProgram === 'WezTerm') return 'kitty';
  if (env.KITTY_WINDOW_ID || term === 'xterm-kitty' || termProgram === 'ghostty' || env.GHOSTTY_RESOURCES_DIR || term === 'xterm-ghostty') {
    return 'kitty-unicode';
  }
  if (termProgram === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return 'iterm';
  return 'halfblock';
}
