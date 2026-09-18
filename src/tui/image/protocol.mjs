// Which inline-image mechanism this terminal supports, best first.
//
//   kitty      APC graphics protocol — Kitty, WezTerm, Ghostty
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
  if (env.MASKSHIFT_IMAGE === 'iterm') return 'iterm';

  const term = env.TERM || '';
  const termProgram = env.TERM_PROGRAM || '';
  if (env.KITTY_WINDOW_ID || term === 'xterm-kitty' || termProgram === 'WezTerm' || termProgram === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) {
    return 'kitty';
  }
  if (termProgram === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return 'iterm';
  return 'halfblock';
}
