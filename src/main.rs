mod app;
mod buffer;
mod components;
mod protocol;
mod storage;
mod transport;

use app::App;

fn main() {
    console_error_panic_hook::set_once();
    leptos::mount::mount_to_body(App);
}
