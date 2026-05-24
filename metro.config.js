const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Exclude temp build directories that Metro's watcher can't handle
config.watchFolders = config.watchFolders || [];
config.resolver = config.resolver || {};
config.resolver.blockList = [
  /node_modules\/.expo-.*\/android\/.*/,
  /node_modules\/.*\/android\/build\/.*/,
];

module.exports = config;
