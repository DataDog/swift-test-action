const core = require('@actions/core');
const exec = require('@actions/exec');
const io = require('@actions/io');
const fetch = require("node-fetch");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temp = os.tmpdir();
const DD_API_KEY = "DD_API_KEY";
const DD_APPLICATION_KEY = "DD_APPLICATION_KEY";


const sdkTestingDir = temp + "/.dd_sdk_testing_dir";
const sdkTestingFrameworkPath = sdkTestingDir +"/dd_sdk_testing/DatadogSDKTesting.xcframework";
const derivedDataPath = sdkTestingDir + "/derived";
const xctestDir = derivedDataPath + "/Build/Products/";
const testrunJson = sdkTestingDir + "/testrun.json";

let envVars = Object.assign({}, process.env);

// most @actions toolkit packages have async methods
async function run() {
  try {
    const apiKey =  core.getInput("api_key");
    const applicationKey =  core.getInput("app_key") || core.getInput("application_key");


    if (!apiKey || !applicationKey) {
      console.error(`Error: Both api_key and app_key parameters are needed for the action`);
      return
    }

    envVars[DD_API_KEY] = apiKey;
    envVars[DD_APPLICATION_KEY] = applicationKey;

    const platform = (core.getInput("platform") || "ios").toLowerCase();

    const sdk = core.getInput("sdk") || getSDKForPlatform(platform);
    const destination = core.getInput("destination") || getDestinationForPlatform(platform);
    const configuration = core.getInput("configuration") || "Debug";
    const libraryVersion = core.getInput("libraryVersion") || "";
    const extraParameters = core.getInput("extraParameters") || "";


    //If project uses testplan force use of code coverage
    const fileList = recFindByExt(".", "xctestplan");
    for (let testPlanFile of fileList) {
      await deleteLinesContaining(testPlanFile, "codeCoverage");
    }

    //Create folder to store files
    if (!fs.existsSync(sdkTestingDir)) {
      fs.mkdirSync(sdkTestingDir);
    }

    //Read project
    const workspace = await getWorkspace();
    const xcodeproj = await getXCodeProj();
    var projectParameter;

    //download testing framework
    await downloadLatestFramework(libraryVersion);

    if (workspace) {
      console.log(`Workspace selected: ${workspace}`);
      projectParameter = "-workspace " + `"${workspace}" `;
    } else if (xcodeproj) {
      console.log(`Project selected: ${xcodeproj}`);
      projectParameter = "-project " + `"${xcodeproj}" `;
    } else if (fs.existsSync("Package.swift")) {
      console.log(`Package.swift selected`);
      await swiftPackageRun(platform, extraParameters);
      return;
    } else {
      core.setFailed(
        "Unable to find workspace, project or Swift package file. Please set with workspace or xcodeproj"
      );
    }

    const scheme = await getScheme(workspace, xcodeproj);
    console.log(`Scheme selected: ${scheme}`);

    //copy configfile
    const configFilePath = `${sdkTestingDir}/ddTesting.xcconfig`;
    createXCConfigFile(configFilePath, sdkTestingDir);



    //build for testing
    const buildCommand = `xcodebuild build-for-testing -enableCodeCoverage YES` +
    ` -xcconfig ${configFilePath} ${projectParameter}` +
    ` -configuration ${configuration}` +
    ` -scheme "${scheme}"`+
    ` -sdk ${sdk}` +
    ` -derivedDataPath ${derivedDataPath}` +
    ` -destination "${destination}"` +
    ` ` + extraParameters
    const result = await exec.exec(buildCommand, null, null);

    //For all testruns that are configured
    let testRuns = await getXCTestRuns();
    let testError;

    for (const testRun of testRuns) {
      //modify xctestrun with Scope variables

      let plutilExportCommand =
        "plutil -convert json -o " + testrunJson + ` "${testRun}"`;
      await exec.exec(plutilExportCommand, null, null);

      let jsonString = fs.readFileSync(testrunJson, "utf8");
      const testTargets = JSON.parse(jsonString);

      //We avoid processing internal metadata
      const testTargetsToModify = Object.keys(testTargets).filter(key => key[0] !== '_')
      for (const target of testTargetsToModify) {
        if (testTargets[target].TestingEnvironmentVariables) {
          await insertEnvVariables(testRun, target);
        } else if (target === "TestConfigurations") {
          let configurationNumber = 0;
          for (const configuration of testTargets["TestConfigurations"]) {
            let testNumber = 0;
            for (const test of configuration["TestTargets"]) {
              await insertEnvVariables(
                testRun,
                `${target}.${configurationNumber}.TestTargets.${testNumber}`
              );
            }
          }
        }
      }
      //run tests
      const testCommand =
        "xcodebuild test-without-building" +
        " -enableCodeCoverage YES" +
        ` -xctestrun "${testRun}"` +
        ` -destination "${destination}"` +
        ` ${extraParameters}`;
      try {
        await exec.exec(testCommand, null, null);
      } catch (error) {
        testError = error.message;
      }
    }
    if (testError) {
      core.setFailed(testError.message);
      console.log(testError.message);
    }

  } catch (error) {
    core.setFailed(error.message);
    console.log(error.message);

  }

    //Clean up
  fs.rmSync(sdkTestingDir, { recursive: true });
}

function getSDKForPlatform(platform) {
  switch (platform) {
    case "macos":
    case "mac":
      return "macosx";
    case "tvos":
      return "appletvsimulator";
    default:
      return "iphonesimulator";
  }
}

function getDestinationForPlatform(platform) {
  switch (platform) {
    case "macos":
    case "mac":
      return "platform=macOS,arch=x86_64";
    case "tvos":
      return "platform=tvOS Simulator,name=Apple TV 4K";
    default:
      return "platform=iOS Simulator,name=iPhone 14";
  }
}

function getFrameworkPathForPlatform(platform) {
  switch (platform) {
    case "macos":
    case "mac":
      return "macos-arm64_x86_64 ";
    case "tvos":
      return "tvos-arm64_x86_64-simulator";
    default:
      return "ios-arm64_x86_64-simulator";
  }
}

async function deleteLinesContaining(file, match) {
  let newName = file + "_old";
  await io.mv(file, newName);
  
  const data = fs.readFileSync(newName, { encoding: "utf-8" })

  let dataArray = data.split("\n"); // convert file data in an array
  const searchKeyword = match; // we are looking for a line, contains, key word 'user1' in the file
  let lastIndex = -1; // let say, we have not found the keyword

  for (let index = 0; index < dataArray.length; index++) {
    if (dataArray[index].includes(searchKeyword)) {
      // check if a line contains the 'user1' keyword
      lastIndex = index; // found a line includes a 'user1' keyword
      break;
    }
  }

  dataArray.splice(lastIndex, 1); // remove the keyword 'user1' from the data Array

  // UPDATE FILE WITH NEW DATA
  // IN CASE YOU WANT TO UPDATE THE CONTENT IN YOUR FILE
  // THIS WILL REMOVE THE LINE CONTAINS 'user1' IN YOUR shuffle.txt FILE
  const updatedData = dataArray.join("\n");
  fs.writeFileSync(file, updatedData);
  console.log("Successfully updated the file data");
}

async function getWorkspace() {
  let workspace = core.getInput("workspace");
  if (!workspace) {
    let myOutput = "";
    const options = {};
    options.listeners = {
      stdout: data => {
        myOutput += data.toString();
        workspace = myOutput.split("\n").find(function(file) {
          return file.match(/\.xcworkspace$/);
        });
      }
    };
    await exec.exec("ls", null, options);
  }
  return workspace;
}

async function getXCodeProj() {
  let xcodeproj = core.getInput("project");
  if (!xcodeproj) {
    let myOutput = "";
    const options = {};
    options.listeners = {
      stdout: data => {
        myOutput += data.toString();
        xcodeproj = myOutput.split("\n").find(function(file) {
          return file.match(/\.xcodeproj/);
        });
      }
    };
    await exec.exec("ls", null, options);
  }
  return xcodeproj;
}

async function getScheme(workspace, xcodeproj) {
  let scheme = core.getInput("scheme");
  if (!scheme) {
    let command;
    if (workspace) {
      command = "xcodebuild -workspace " + workspace + " -list -json";
    } else {
      command = "xcodebuild -project " + xcodeproj + " -list -json";
    }
    let myOutput = "";
    const options = {};
    options.listeners = {
      stdout: data => {
        myOutput += data.toString();
      }
    };
    try {
      await exec.exec(command, null, options);
    } catch (error) {
      core.setFailed(
        "Unable to automatically select a Scheme. Please set with .scheme parameter"
      );
      throw error;
    }
    const info = JSON.parse(myOutput);
    const aux = info.workspace || info.project;
    const schemes = aux.schemes;
    console.log("Available schemes: " + JSON.stringify(schemes));
    scheme = intelligentSelectScheme(schemes, aux);
  }
  return scheme;
}

function intelligentSelectScheme(schemes, workspacePath) {
  if (schemes.length < 1) {
    return null;
  }
  const workspaceName = workspacePath.name;
  if (schemes.includes(workspaceName)) {
    return workspaceName;
  }
  var el = schemes.find(a => a.includes(workspaceName));

  return el || schemes[0];
}

async function downloadLatestFramework(libraryVersion) {
  let sdkURL = "";

  if (libraryVersion) {
    sdkURL = `https://github.com/DataDog/dd-sdk-swift-testing/releases/download/${libraryVersion}/DatadogSDKTesting.zip`
  } else {
    sdkURL = `https://github.com/DataDog/dd-sdk-swift-testing/releases/latest/download/DatadogSDKTesting.zip`
  }

  const sdkTestingPath = sdkTestingDir + "/dd_sdk_testing.zip";
  console.log(`dd_sdk_testing downloading: ${sdkURL}`);
  await downloadFile(sdkURL, sdkTestingPath);

  const extractCommand =
    "ditto -x -k " + sdkTestingPath + " " + sdkTestingDir + "/dd_sdk_testing";
  await exec.exec(extractCommand, null, null);
}

const downloadFile = async (url, path) => {
  const res = await fetch(url);
  if (res.status === 404) {
    console.error(`Desired testing library version not found`);
  }
  const fileStream = fs.createWriteStream(path);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", err => {
      reject(err);
    });
    fileStream.on("finish", function() {
      resolve();
    });
  });
};


function createXCConfigFile(path, scopeFrameworkPath) {
  let configText =
    `
  // Configuration settings file format documentation can be found at:
  // https://help.apple.com/xcode/#/dev745c5c974
 
  DEBUG_INFORMATION_FORMAT = dwarf-with-dsym
  ` +
    "FRAMEWORK_SEARCH_PATHS[sdk=macosx*] = $(inherited) " + sdkTestingFrameworkPath + "/macos-arm64_x86_64/" + "\n" +
    "LD_RUNPATH_SEARCH_PATHS[sdk=macosx*] = $(inherited) " + sdkTestingFrameworkPath + "/macos-arm64_x86_64/" + "\n" +
    "FRAMEWORK_SEARCH_PATHS[sdk=iphonesimulator*] = $(inherited) " + sdkTestingFrameworkPath + "/ios-arm64_x86_64-simulator/" + "\n" +
    "LD_RUNPATH_SEARCH_PATHS[sdk=iphonesimulator*] = $(inherited) " + sdkTestingFrameworkPath + "/ios-arm64_x86_64-simulator/" + "\n" +
    "FRAMEWORK_SEARCH_PATHS[sdk=appletvsimulator*] = $(inherited) " + sdkTestingFrameworkPath + "/tvos-arm64_x86_64-simulator/" + "\n" +
    "LD_RUNPATH_SEARCH_PATHS[sdk=appletvsimulator*] = $(inherited) " + sdkTestingFrameworkPath + "/tvos-arm64_x86_64-simulator/" + "\n" +
    "OTHER_LDFLAGS =  $(inherited)  -framework DatadogSDKTesting\n"
    ;

  fs.writeFileSync(path, configText, null);
}

async function getXCTestRuns() {
  let myOutput = "";
  let testRuns = [""];
  const options = {};
  options.listeners = {
    stdout: data => {
      myOutput += data.toString();
      testRuns = myOutput.split("\n").filter(function(file) {
        return file.match(/\.xctestrun$/);
      });
    }
  };
  await exec.exec("ls " + xctestDir, null, options);
  testRuns.forEach(function(part, index, theArray) {
    theArray[index] = xctestDir + part;
  });
  return testRuns;
}

async function insertEnvVariables(file, target) {
  //Base setting
  await insertEnvVariable("DD_TEST_RUNNER", 1, file, target);
  await insertEnvVariable( "SRCROOT", envVars["GITHUB_WORKSPACE"]|| "", file, target );
  await insertEnvVariable(DD_API_KEY, envVars[DD_API_KEY], file, target);
  await insertEnvVariable(DD_APPLICATION_KEY, envVars[DD_APPLICATION_KEY], file, target);

  //GitHub settings
  await insertEnvVariable( "GITHUB_WORKSPACE", envVars["GITHUB_WORKSPACE"] || "", file, target);
  await insertEnvVariable( "GITHUB_REPOSITORY", envVars["GITHUB_REPOSITORY"] || "", file, target);
  await insertEnvVariable( "GITHUB_SERVER_URL", envVars["GITHUB_SERVER_URL"] || "", file, target );
  await insertEnvVariable( "GITHUB_SHA", envVars["GITHUB_SHA"] || "", file, target);
  await insertEnvVariable( "GITHUB_RUN_ID", envVars["GITHUB_RUN_ID"] || "", file, target);
  await insertEnvVariable( "GITHUB_RUN_NUMBER", envVars["GITHUB_RUN_ATTEMPT"] || "", file, target );
  await insertEnvVariable( "GITHUB_WORKFLOW", envVars["GITHUB_WORKFLOW"] || "", file, target);
  await insertEnvVariable( "GITHUB_HEAD_REF", envVars["GITHUB_HEAD_REF"] || "", file, target);
  await insertEnvVariable( "GITHUB_REF", envVars["GITHUB_REF"] || "", file, target);
  await insertEnvVariable( "GITHUB_REPOSITORY", envVars["GITHUB_REPOSITORY"] || "", file, target );
  await insertEnvVariable( "GITHUB_SERVER_URL", envVars["GITHUB_SERVER_URL"] || "", file, target );
  await insertEnvVariable( "GITHUB_RUN_ID", envVars["GITHUB_RUN_ATTEMPT"] || "", file, target );

  //Configuration settings
  await insertEnvVariable( "DD_SERVICE", envVars["DD_SERVICE"] || "", file, target );
  await insertEnvVariable( "DD_TAGS", envVars["DD_TAGS"] || "", file, target );
  await insertEnvVariable( "DD_DISABLE_TEST_INSTRUMENTING", envVars["DD_DISABLE_TEST_INSTRUMENTING"] || "", file, target );
  await insertEnvVariable( "DD_DISABLE_NETWORK_INSTRUMENTATION", envVars["DD_DISABLE_NETWORK_INSTRUMENTATION"] || "", file, target );
  await insertEnvVariable( "DD_DISABLE_HEADERS_INJECTION", envVars["DD_DISABLE_HEADERS_INJECTION"] || "", file, target );
  await insertEnvVariable( "DD_INSTRUMENTATION_EXTRA_HEADERS", envVars["DD_INSTRUMENTATION_EXTRA_HEADERS"] || "", file, target );
  await insertEnvVariable( "DD_EXCLUDED_URLS", envVars["DD_EXCLUDED_URLS"] || "", file, target );
  await insertEnvVariable( "DD_ENABLE_RECORD_PAYLOAD", envVars["DD_ENABLE_RECORD_PAYLOAD"] || "", file, target );
  await insertEnvVariable( "DD_DISABLE_NETWORK_CALL_STACK", envVars["DD_DISABLE_NETWORK_CALL_STACK"] || "", file, target );
  await insertEnvVariable( "DD_ENABLE_NETWORK_CALL_STACK_SYMBOLICATED", envVars["DD_ENABLE_NETWORK_CALL_STACK_SYMBOLICATED"] || "", file, target );
  await insertEnvVariable( "DD_DISABLE_RUM_INTEGRATION", envVars["DD_DISABLE_RUM_INTEGRATION"] || "", file, target );
  await insertEnvVariable( "DD_MAX_PAYLOAD_SIZE", envVars["DD_MAX_PAYLOAD_SIZE"] || "", file, target );
  await insertEnvVariable( "DD_CIVISIBILITY_LOGS_ENABLED", envVars["DD_CIVISIBILITY_LOGS_ENABLED"] || "", file, target );
  await insertEnvVariable( "DD_ENABLE_STDOUT_INSTRUMENTATION", envVars["DD_ENABLE_STDOUT_INSTRUMENTATION"] || "", file, target );
  await insertEnvVariable( "DD_ENABLE_STDERR_INSTRUMENTATION", envVars["DD_ENABLE_STDERR_INSTRUMENTATION"] || "", file, target );
  await insertEnvVariable( "DD_DISABLE_SDKIOS_INTEGRATION", envVars["DD_DISABLE_SDKIOS_INTEGRATION"] || "", file, target );
  await insertEnvVariable( "DD_DISABLE_CRASH_HANDLER", envVars["DD_DISABLE_CRASH_HANDLER"] || "", file, target );
  await insertEnvVariable( "DD_SITE", envVars["DD_SITE"] || "", file, target );
  await insertEnvVariable( "DD_ENDPOINT", envVars["DD_ENDPOINT"] || "", file, target );
  await insertEnvVariable( "DD_DONT_EXPORT", envVars["DD_DONT_EXPORT"] || "", file, target );
  await insertEnvVariable( "DD_TRACE_DEBUG", envVars["DD_TRACE_DEBUG"] || "", file, target );
  await insertEnvVariable( "DD_TRACE_DEBUG_CALLSTACK", envVars["DD_TRACE_DEBUG_CALLSTACK"] || "", file, target );
  await insertEnvVariable( "DD_DISABLE_GIT_INFORMATION", envVars["DD_DISABLE_GIT_INFORMATION"] || "", file, target );
  await insertEnvVariable( "DD_CIVISIBILITY_EXCLUDED_BRANCHES", envVars["DD_CIVISIBILITY_EXCLUDED_BRANCHES"] || "", file, target );
  await insertEnvVariable( "DD_CIVISIBILITY_ITR_ENABLED", envVars["DD_CIVISIBILITY_ITR_ENABLED"] || "", file, target );
  await insertEnvVariable( "DD_CIVISIBILITY_CODE_COVERAGE_ENABLED", envVars["DD_CIVISIBILITY_CODE_COVERAGE_ENABLED"] || "", file, target );
}

async function insertEnvVariable(name, value, file, target) {
  if (value !== "") {
    let insertCommand =
      'plutil -replace "' +
      target +
      ".EnvironmentVariables." +
      name +
      '" -string' +
      ` "${value}"` +
      ` "${file}"`;
    await exec.exec(insertCommand, null, null);
  }
}

function recFindByExt(base, ext, files, result) {
  files = files || fs.readdirSync(base);
  result = result || [];

  files.forEach(function(file) {
    var newbase = path.join(base, file);
    if (fs.statSync(newbase).isDirectory()) {
      result = recFindByExt(newbase, ext, fs.readdirSync(newbase), result);
    } else {
      if (file.substr(-1 * (ext.length + 1)) === "." + ext) {
        result.push(newbase);
      }
    }
  });
  return result;
}

async function swiftPackageRun(platform, extraParameters) {
  //build and test
  let buildTestCommand =
    "swift test" +
    " --enable-code-coverage" +
    " -Xswiftc -g -Xswiftc -debug-info-format=dwarf" +
    " -Xswiftc" +
    " -F" +
    sdkTestingFrameworkPath + "/" + getFrameworkPathForPlatform(platform) +
    " -Xswiftc -framework -Xswiftc DatadogSDKTesting -Xlinker -rpath -Xlinker " +
    sdkTestingFrameworkPath + "/" + getFrameworkPathForPlatform(platform) +
    " " +
    extraParameters;

  let testError;
  try {
    const options = {};
    options.env = {
      ...envVars,
      "DD_TEST_RUNNER": "1",
      "SRCROOT": envVars["GITHUB_WORKSPACE"],
    };
    options.listeners = {
      stdout: data => {
        console.log(data.toString());
      }
    };
    
    await exec.exec(buildTestCommand, null, options);
  } catch (error) {
    testError = error.message;
  }

  if (testError) {
    core.setFailed(testError.message);
  }

}

run();
