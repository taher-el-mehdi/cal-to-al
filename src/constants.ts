/**
 * Constants and configuration for the CAL to AL converter
 */

export const CONFIG_NAMESPACE = 'calToAl';

export const EXECUTABLE_NAMES = {
  TXT2AL_WINDOWS: 'Txt2Al.exe',
};

export const DIRECTORY_NAMES = {
  WORKSPACE_BIN: 'bin',
  AL_OUTPUT: 'src-cal-to-al',
  TEMP_CONVERSION: '.caltoal-temp',
};

export const CONVERSION_SETTINGS = {
  rename: 'rename',
  type: 'type',
  extensionStartId: 'extensionStartId',
  stacktrace: 'stacktrace',
  injectDotNetAddIns: 'injectDotNetAddIns',
  dotNetAddInsPackage: 'dotNetAddInsPackage',
  multithreaded: 'multithreaded',
  dotNetTypePrefix: 'dotNetTypePrefix',
  translationFormat: 'translationFormat',
  addLegacyTranslationInfo: 'addLegacyTranslationInfo',
  runtime: 'runtime',
  objectFileNamePattern: 'objectFileNamePattern',
  extensionObjectFileNamePattern: 'extensionObjectFileNamePattern',
  format: 'format',
  dataClassificationDefaulting: 'dataClassificationDefaulting',
  tableDataOnly: 'tableDataOnly',
  txt2alPath: 'txt2alPath',
  logFilePath: 'logFilePath',
  verboseLogging: 'verboseLogging',
};
