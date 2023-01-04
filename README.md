![logo](CIVislogo.png)

# CI Visibility for Swift Action

GitHub Action to run your Swift or Objective-C tests automatically instrumented with CI Visibility [Swift Testing framework](https://docs.datadoghq.com/continuous_integration/tests/swift). It supports Xcode projects as well as Swift Package Manager packages for iOS, macOS and tvOS platforms.

## About Datadog Continuous Integration (CI) Visibility

[CI Visibility](https://docs.datadoghq.com/continuous_integration/) brings together information about CI test and pipeline results plus data about CI performance, trends, and reliability, all into one place. Not only does it provide developers with the ability to dig into the reasons for a test or pipeline failure, to monitor trends in test suite execution times, or to see the effect a given commit has on the pipeline, it also gives build engineers visibility into cross-organization CI health and trends in pipeline performance over time.

## Usage

1. Set [Datadog API key](https://app.datadoghq.com/organization-settings/api-keys) inside Settings > Secrets as `DD_API_KEY`.
2. Set [Datadog Application key](https://app.datadoghq.com/organization-settings/application-keys) inside Settings > Secrets as `DD_APPLICATION_KEY`.
3. Add a step to your GitHub Actions workflow YAML that uses this action:

   ```yaml
   steps:
     - name: Checkout
       uses: actions/checkout@v3
    - name: Run tests with Datadog 
      uses: Datadog/swift-test-action@v1
      with:
          api_key: ${{ secrets.DD_API_KEY }}
          application_key: ${{ secrets.DD_APPLICATION_KEY }}
   ```

## Configuration

These are the optional parameters of the action:

```yaml
platform: Platform to run: "ios", "macos" or "tvos". By default: "ios"
workspace: .xcworkspace file, if not set, workspace will be autoselected
project: .xcodeproj file, if not set, project will be autoselected
scheme: Scheme to test, if not set, scheme will be autoselected
sdk: SDK used for building, by default: "iphonesimulator" will be used
destination: Destination for testing, by default: "platform=iOS Simulator,name=iPhone 13"
configuration: Configuration for testing, by default: "Debug"
libraryVersion: Version of the Datagog SDK testing framework to use for testing, by default the latest stable
extraParameters: These input will be added directly to the build/test command
```
There are also extra configuration values that can be set using environment values to the action as specified in the Swift framework [documentation](https://docs.datadoghq.com/continuous_integration/tests/swift#additional-optional-configuration)
