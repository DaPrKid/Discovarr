plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.daprkid.discovarrtv"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.daprkid.discovarrtv"
        // Compose 1.10 requires 23, which is Android TV 6.0 — every box still
        // receiving updates. Older FireTV sticks cannot run this.
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            // No shrinking: the app has no reflection and only a handful of
            // classes, so minification would buy nothing and risk breakage.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    // The only dependencies are the Compose runtime and the Kotlin standard
    // library. HTTP is HttpURLConnection and JSON is org.json, both in android.jar.
    implementation(platform("androidx.compose:compose-bom:2025.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.12.4")
}
