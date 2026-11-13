// Pinned deliberately: this app is built on an Unraid box or a laptop, not in
// an always-updated CI, so every version here is one that is known to resolve.
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.21" apply false
}
