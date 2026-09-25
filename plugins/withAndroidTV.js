// Makes the Android build a first-class Android TV / Fire TV app:
// leanback launcher entry, TV banner, and no hard touchscreen requirement.
const fs = require('fs');
const path = require('path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

function ensureFeature(manifest, name) {
  manifest['uses-feature'] = manifest['uses-feature'] || [];
  if (!manifest['uses-feature'].some((f) => f.$['android:name'] === name)) {
    manifest['uses-feature'].push({ $: { 'android:name': name, 'android:required': 'false' } });
  }
}

module.exports = function withAndroidTV(config, { banner = './assets/tv/banner.png' } = {}) {
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    ensureFeature(manifest, 'android.software.leanback');
    ensureFeature(manifest, 'android.hardware.touchscreen');
    ensureFeature(manifest, 'android.hardware.faketouch');

    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:banner'] = '@drawable/tv_banner';

    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    const main = (activity['intent-filter'] || []).find((f) =>
      (f.action || []).some((a) => a.$['android:name'] === 'android.intent.action.MAIN')
    );
    if (main) {
      main.category = main.category || [];
      if (!main.category.some((c) => c.$['android:name'] === 'android.intent.category.LEANBACK_LAUNCHER')) {
        main.category.push({ $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' } });
      }
    }
    return cfg;
  });

  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/drawable-xhdpi');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.resolve(cfg.modRequest.projectRoot, banner), path.join(dir, 'tv_banner.png'));
      return cfg;
    },
  ]);
};
