// The renderer is bundled by Expo and the desktop service uses only Node built-ins.
// Tell electron-builder that no production node_modules need collecting/rebuilding;
// otherwise it searches parent projects and includes the React Native toolchain.
module.exports = async () => false;
