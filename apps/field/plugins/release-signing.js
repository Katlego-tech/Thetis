// Expo config plugin: signs the Android release build with the Thetis upload key. The keystore
// and its password stay outside the repo; the build reads their locations from Gradle properties
// (~/.gradle/gradle.properties) or environment variables of the same names:
//   THETIS_UPLOAD_STORE_FILE     absolute path of the upload keystore (.jks)
//   THETIS_UPLOAD_KEY_ALIAS      the key's alias in that keystore
//   THETIS_UPLOAD_PASSWORD_FILE  a file holding the keystore and key password, read at build time
// Without them a release is refused rather than debug-signed or left unsigned (docs/dapp-store.md).
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// Thetis release signing";

const SIGNING = `
        release {
            ${MARK}: values come from Gradle properties or the environment, never this file.
            def upload = { name -> findProperty(name) ?: System.getenv(name) }
            def storePath = upload('THETIS_UPLOAD_STORE_FILE')
            def passwordPath = upload('THETIS_UPLOAD_PASSWORD_FILE')
            if (storePath && passwordPath) {
                def password = file(passwordPath).text.trim()
                storeFile file(storePath)
                storePassword password
                keyAlias upload('THETIS_UPLOAD_KEY_ALIAS')
                keyPassword password
            }
        }`;

const GUARD = `${MARK}: a release is never packaged debug-signed or unsigned.
gradle.taskGraph.whenReady { graph ->
    def packagesRelease = graph.allTasks.any { task ->
        task.project == project && (task.name == 'packageRelease' || task.name == 'signReleaseBundle')
    }
    if (packagesRelease && android.signingConfigs.release.storeFile == null) {
        throw new GradleException('Release signing needs THETIS_UPLOAD_STORE_FILE, THETIS_UPLOAD_KEY_ALIAS and THETIS_UPLOAD_PASSWORD_FILE as Gradle properties or environment variables (docs/dapp-store.md).')
    }
}

`;

const DEBUG_SIGNING = /(signingConfigs \{\n\s*debug \{[^}]*\})/;
const RELEASE_TYPE =
  /(buildTypes \{[\s\S]*?\n\s*release \{[\s\S]*?)signingConfig signingConfigs\.debug/;
const AFTER_ANDROID =
  "// Apply static values from `gradle.properties` to the `android.packagingOptions`";

/** Rewrites the prebuilt android/app/build.gradle text; exported for the unit test. */
function applyReleaseSigning(gradle) {
  if (gradle.includes(MARK)) return gradle;
  if (!DEBUG_SIGNING.test(gradle)) {
    throw new Error(
      "release-signing: no signingConfigs { debug { ... } } block in app/build.gradle",
    );
  }
  if (!RELEASE_TYPE.test(gradle)) {
    throw new Error("release-signing: the release build type does not use signingConfigs.debug");
  }
  if (!gradle.includes(AFTER_ANDROID)) {
    throw new Error(
      "release-signing: the end of the android block was not found in app/build.gradle",
    );
  }
  return gradle
    .replace(DEBUG_SIGNING, `$1${SIGNING}`)
    .replace(RELEASE_TYPE, "$1signingConfig signingConfigs.release")
    .replace(AFTER_ANDROID, `${GUARD}${AFTER_ANDROID}`);
}

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== "groovy") {
      throw new Error("release-signing: app/build.gradle is not Groovy");
    }
    mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
    return mod;
  });
}

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
