//! Windows consoles: single keys and ANSI output through the console
//! mode, the same way other terminal programs get them (Node's
//! `setRawMode` is `SetConsoleMode` underneath). One of the few files with
//! platform code (ARCHITECTURE.md, "Platform-Specific Code"): `kernel32`
//! functions std links anyway, declared here; no crate.
//!
//! Input: line input and echo off, so keys arrive one at a time without
//! Enter; virtual terminal input on, so arrows arrive as the escape
//! sequences a Unix terminal sends (`ESC [ C`, `crate::ui::confirm::Keys`);
//! processed input stays on, so Ctrl-C still raises the console's control
//! event (`tvpipe::signals`). Output: virtual terminal processing on stderr
//! (Windows 10 1511 and later), so the status line and colours work in
//! the classic console host, which does not say so in `TERM`.
//!
//! Sources: Microsoft's console documentation (GetStdHandle,
//! GetConsoleMode, SetConsoleMode, GetConsoleScreenBufferInfo, "Console
//! Virtual Terminal Sequences").

use std::ffi::c_void;

type Handle = *mut c_void;

/// `(DWORD)-10`, `(DWORD)-12`.
const STD_INPUT_HANDLE: u32 = -10i32 as u32;
const STD_ERROR_HANDLE: u32 = -12i32 as u32;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

const ENABLE_PROCESSED_INPUT: u32 = 0x0001;
const ENABLE_LINE_INPUT: u32 = 0x0002;
const ENABLE_ECHO_INPUT: u32 = 0x0004;
const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x0200;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;

#[repr(C)]
#[derive(Default)]
struct Coord {
    x: i16,
    y: i16,
}

#[repr(C)]
#[derive(Default)]
struct SmallRect {
    left: i16,
    top: i16,
    right: i16,
    bottom: i16,
}

#[repr(C)]
#[derive(Default)]
struct ScreenBufferInfo {
    size: Coord,
    cursor: Coord,
    attributes: u16,
    window: SmallRect,
    max_window: Coord,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetStdHandle(which: u32) -> Handle;
    fn GetConsoleMode(console: Handle, mode: *mut u32) -> i32;
    fn SetConsoleMode(console: Handle, mode: u32) -> i32;
    fn GetConsoleScreenBufferInfo(console: Handle, info: *mut ScreenBufferInfo) -> i32;
}

/// The process's handle `which`, if it has one.
fn std_handle(which: u32) -> Option<Handle> {
    // SAFETY: GetStdHandle takes any value and returns a handle, NULL or
    // INVALID_HANDLE_VALUE; it has no other effects.
    let h = unsafe { GetStdHandle(which) };
    (!h.is_null() && h != INVALID_HANDLE_VALUE).then_some(h)
}

/// The console mode of `which`; `None` when it is not a console (a pipe,
/// a file, an MSYS terminal's pipe).
fn mode(which: u32) -> Option<u32> {
    let h = std_handle(which)?;
    let mut mode = 0u32;
    // SAFETY: `h` is a live standard handle and `mode` a valid out
    // pointer; GetConsoleMode fails (0) for handles that are not consoles.
    (unsafe { GetConsoleMode(h, &mut mode) } != 0).then_some(mode)
}

fn set_mode(which: u32, mode: u32) -> bool {
    let Some(h) = std_handle(which) else {
        return false;
    };
    // SAFETY: `h` is a live standard handle; SetConsoleMode fails (0) for
    // handles that are not consoles and for modes the console rejects.
    unsafe { SetConsoleMode(h, mode) != 0 }
}

/// The input console's mode, before tvpipe changes it.
pub fn input_mode() -> Option<u32> {
    mode(STD_INPUT_HANDLE)
}

/// `saved` (from [`input_mode`]) with single keys: no lines, no echo,
/// arrows as escape sequences, Ctrl-C still a signal.
pub fn keys_mode(saved: u32) -> u32 {
    (saved & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT))
        | ENABLE_PROCESSED_INPUT
        | ENABLE_VIRTUAL_TERMINAL_INPUT
}

/// `saved` without echo (a password typed as a line).
pub fn no_echo_mode(saved: u32) -> u32 {
    saved & !ENABLE_ECHO_INPUT
}

/// Sets the input console's mode.
pub fn set_input_mode(mode: u32) -> bool {
    set_mode(STD_INPUT_HANDLE, mode)
}

/// Turns on ANSI escape sequences on stderr's console; whether they work
/// now (they may have been on already).
pub fn ansi_stderr() -> bool {
    let Some(m) = mode(STD_ERROR_HANDLE) else {
        return false;
    };
    m & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0
        || set_mode(STD_ERROR_HANDLE, m | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
}

/// The columns of stderr's console window.
pub fn columns() -> Option<usize> {
    let h = std_handle(STD_ERROR_HANDLE)?;
    let mut info = ScreenBufferInfo::default();
    // SAFETY: `h` is a live standard handle and `info` a valid,
    // correctly laid out CONSOLE_SCREEN_BUFFER_INFO; the call fails (0)
    // for handles that are not console screen buffers.
    if unsafe { GetConsoleScreenBufferInfo(h, &mut info) } == 0 {
        return None;
    }
    let w = info.window.right as i32 - info.window.left as i32 + 1;
    (w > 0).then_some(w as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes() {
        // A console's default: processed, line, echo, insert, quick edit…
        let saved = 0x01f7;
        let keys = keys_mode(saved);
        assert_eq!(keys & (ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT), 0);
        assert_ne!(keys & ENABLE_PROCESSED_INPUT, 0);
        assert_ne!(keys & ENABLE_VIRTUAL_TERMINAL_INPUT, 0);
        // The rest stays as it was.
        assert_eq!(keys & 0x01f0, saved & 0x01f0);
        assert_eq!(no_echo_mode(saved), saved & !ENABLE_ECHO_INPUT);
    }
}
