// Runs the Android project's Gradle wrapper (docs/android.md) with a JDK and
// Android SDK found the usual places, so `npm run android:apk` works without
// setting JAVA_HOME or ANDROID_HOME by hand. Arguments go to Gradle.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const windows = process.platform === 'win32';
const first = (list) => list.find((p) => p && existsSync(p));
const env = { ...process.env };

env.JAVA_HOME = first([
  process.env.JAVA_HOME,
  // Android Studio's bundled JDK.
  windows && 'C:\\Program Files\\Android\\Android Studio\\jbr',
  process.platform === 'darwin' && '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  process.platform === 'linux' && '/opt/android-studio/jbr',
]);
env.ANDROID_HOME = first([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  windows && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  process.platform === 'darwin' && join(homedir(), 'Library', 'Android', 'sdk'),
  join(homedir(), 'Android', 'Sdk'),
]);
if (!env.JAVA_HOME) {
  console.error('No JDK found. Install Android Studio or JDK 21 and set JAVA_HOME.');
  process.exit(1);
}
if (!env.ANDROID_HOME) {
  console.error('No Android SDK found. Install it with Android Studio and set ANDROID_HOME.');
  process.exit(1);
}
const cwd = resolve('android');
const result = spawnSync(join(cwd, windows ? 'gradlew.bat' : 'gradlew'), process.argv.slice(2), {
  cwd,
  env,
  stdio: 'inherit',
  shell: windows,
});
process.exit(result.status ?? 1);
