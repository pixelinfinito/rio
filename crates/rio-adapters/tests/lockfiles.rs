use pep508_rs::{MarkerEnvironment, MarkerEnvironmentBuilder};
use rio_adapters::{DependencyEnvironment, Ecosystem, parse_lockfile};
use std::{collections::BTreeSet, fs, path::Path};

fn fixture(name: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/lockfiles")
            .join(name),
    )
    .unwrap()
}

fn python_environment() -> DependencyEnvironment {
    DependencyEnvironment {
        python: Some(
            MarkerEnvironment::try_from(MarkerEnvironmentBuilder {
                implementation_name: "cpython",
                implementation_version: "3.12.3",
                os_name: "posix",
                platform_machine: "x86_64",
                platform_python_implementation: "CPython",
                platform_release: "6.8",
                platform_system: "Linux",
                platform_version: "6.8",
                python_full_version: "3.12.3",
                python_version: "3.12",
                sys_platform: "linux",
            })
            .unwrap(),
        ),
        ..Default::default()
    }
}

#[test]
fn recorded_javascript_lockfiles_preserve_packages_and_resolved_edges() {
    for (recorded, format) in [
        ("npm-v2-package-lock.json", "package-lock.json"),
        ("npm-v3-package-lock.json", "package-lock.json"),
        ("pnpm-pnpm-lock.yaml", "pnpm-lock.yaml"),
        ("yarn-classic-yarn.lock", "yarn.lock"),
        ("yarn-berry-yarn.lock", "yarn.lock"),
    ] {
        let graph = parse_lockfile(format, &fixture(recorded)).unwrap();
        assert!(graph.complete, "{recorded}: {:?}", graph.notes);
        let flattened = graph.flattened();
        for (name, version) in [
            ("debug", "4.4.3"),
            ("ms", "2.1.3"),
            ("is-number", "7.0.0"),
            ("@types/ms", "2.1.0"),
            ("fsevents", "2.3.3"),
        ] {
            assert!(
                flattened.contains(&(Ecosystem::Npm, name.into(), version.into())),
                "{recorded}: {name} {version}"
            );
        }
        let debug = graph
            .nodes
            .values()
            .find(|node| node.name == "debug")
            .unwrap();
        let ms = debug
            .dependencies
            .iter()
            .find(|edge| edge.name == "ms")
            .unwrap();
        assert_eq!(graph.nodes[&ms.target].version, "2.1.3");
        assert_eq!(
            graph.hash().unwrap(),
            parse_lockfile(format, &fixture(recorded))
                .unwrap()
                .hash()
                .unwrap()
        );
    }
}

#[test]
fn npm_preserves_nested_locations_platform_flags_and_optional_dev_edges() {
    let graph = parse_lockfile("package-lock.json", r#"{"lockfileVersion":3,"packages":{
        "":{"dependencies":{"lodash":"4.17.21","legacy":"1.0.0"},"devDependencies":{"dev":"1.0.0"},"optionalDependencies":{"windows":"1.0.0"}},
        "node_modules/lodash":{"version":"4.17.21"},
        "node_modules/legacy":{"version":"1.0.0","dependencies":{"lodash":"3.10.1"}},
        "node_modules/legacy/node_modules/lodash":{"version":"3.10.1"},
        "node_modules/dev":{"version":"1.0.0","dev":true},
        "node_modules/windows":{"version":"1.0.0","optional":true,"os":["win32"],"cpu":["x64"],"libc":["glibc"]}
    }}"#).unwrap();
    assert!(graph.complete, "{:?}", graph.notes);
    assert_eq!(
        graph.nodes["node_modules/legacy"].dependencies[0].target,
        "node_modules/legacy/node_modules/lodash"
    );
    let env = DependencyEnvironment {
        os: "linux".into(),
        omit_dev: true,
        ..Default::default()
    };
    let effective = graph.effective(".", &env).unwrap();
    assert!(!effective.nodes.contains_key("node_modules/windows"));
    assert!(!effective.nodes["node_modules/dev"].required);
    assert!(effective.nodes["node_modules/lodash"].required);
}

#[test]
fn pnpm_workspace_importers_peers_and_old_snapshot_keys_resolve() {
    let graph = parse_lockfile(
        "pnpm-lock.yaml",
        r#"
lockfileVersion: '9.0'
importers:
  .: {}
  packages/api:
    dependencies:
      shared: {specifier: 'workspace:*', version: 'link:../shared'}
      debug: {specifier: '4', version: '4.4.3(supports-color@8.0.0)'}
  packages/shared:
    dependencies:
      ms: {specifier: '2', version: '2.1.3'}
packages:
  debug@4.4.3: {os: [linux], cpu: [x64]}
  ms@2.1.3: {}
  supports-color@8.0.0: {}
snapshots:
  debug@4.4.3(supports-color@8.0.0):
    dependencies: {ms: 2.1.3, supports-color: 8.0.0}
  ms@2.1.3: {}
  supports-color@8.0.0: {}
"#,
    )
    .unwrap();
    assert!(graph.complete, "{:?}", graph.notes);
    let effective = graph
        .effective(
            "packages/api",
            &DependencyEnvironment {
                os: "linux".into(),
                cpu: "x64".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        effective
            .nodes
            .contains_key("debug@4.4.3(supports-color@8.0.0)")
    );
    assert!(effective.nodes.contains_key("ms@2.1.3"));
    assert_eq!(
        graph.nodes["packages/api::shared"].link.as_deref(),
        Some("packages/shared")
    );
    let legacy = parse_lockfile(
        "pnpm-lock.yaml",
        "lockfileVersion: 5.4\ndependencies: {foo: 1.0.0}\npackages:\n  /foo/1.0.0: {}\n",
    )
    .unwrap();
    assert!(legacy.complete);
    assert_eq!(legacy.nodes["/foo/1.0.0"].name, "foo");
}

#[test]
fn uv_groups_optional_extras_and_environment_markers_survive_effective_selection() {
    let graph = parse_lockfile(
        "uv.lock",
        r#"
version = 1
[[package]]
name = "app"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{name = "requests"}, {name = "colorama", marker = "sys_platform == 'win32'"}]
[package.dev-dependencies]
dev = [{name = "pytest"}]
[package.optional-dependencies]
security = [{name = "cryptography"}]
[[package]]
name = "requests"
version = "2.32.3"
source = {registry = "https://pypi.org/simple"}
[[package]]
name = "pytest"
version = "8.3.4"
[[package]]
name = "colorama"
version = "0.4.6"
[[package]]
name = "cryptography"
version = "44.0.0"
"#,
    )
    .unwrap();
    assert!(graph.complete, "{:?}", graph.notes);
    let mut env = python_environment();
    env.omit_dev = true;
    let effective = graph.effective(".", &env).unwrap();
    assert!(effective.nodes["requests"].required);
    assert!(!effective.nodes["pytest"].required);
    assert!(!effective.nodes["colorama"].required);
    assert!(!effective.nodes["cryptography"].required);
    assert!(
        graph.importers["."]
            .dependencies
            .iter()
            .any(|edge| edge.extra.as_deref() == Some("security"))
    );
}

#[test]
fn poetry_and_pipfile_preserve_groups_extras_markers_and_dependencies() {
    let graph = parse_lockfile(
        "poetry.lock",
        r#"
[[package]]
name = "Requests"
version = "2.32.3"
optional = false
python-versions = ">=3.8"
groups = ["main"]
[package.dependencies]
urllib3 = ">=1.26,<3"
[[package]]
name = "urllib3"
version = "2.3.0"
groups = ["main"]
[[package]]
name = "pytest"
version = "8.3.4"
groups = ["dev"]
markers = "python_version >= '3.8'"
[[package]]
name = "pyopenssl"
version = "25.0.0"
groups = ["main"]
optional = true
[extras]
security = ["pyopenssl"]
"#,
    )
    .unwrap();
    assert_eq!(graph.nodes["requests"].dependencies[0].target, "urllib3");
    assert_eq!(
        graph.nodes["pyopenssl"].flags.extras,
        BTreeSet::from(["security".into()])
    );
    let mut env = python_environment();
    env.omit_dev = true;
    let effective = graph.effective(".", &env).unwrap();
    assert!(effective.nodes["requests"].required);
    assert!(!effective.nodes["pytest"].required);
    let graph = parse_lockfile("Pipfile.lock", r#"{"_meta":{},"default":{"requests":{"version":"==2.32.3","markers":"python_version >= '3.8'","extras":["security"]}},"develop":{"pytest":{"version":"==8.3.4"}}}"#).unwrap();
    assert!(graph.complete);
    assert!(graph.nodes["pytest"].flags.dev);
    assert!(graph.nodes["requests"].flags.markers.is_some());
}

#[test]
fn requirements_exact_pins_comments_hashes_and_multiline_are_supported_ranges_are_unverified() {
    let graph = parse_lockfile("requirements-prod.txt", "# pinned\nRequests==2.32.3 \\\n --hash=sha256:abcdef\ncolorama==0.4.6 ; sys_platform == 'win32' # platform\n").unwrap();
    assert!(graph.complete, "{:?}", graph.notes);
    assert_eq!(graph.nodes["requests"].version, "2.32.3");
    assert!(graph.nodes["colorama"].flags.markers.is_some());
    for text in [
        "requests>=2",
        "requests==2.*",
        "-r other.txt",
        "requests @ https://example.com/pkg.whl",
    ] {
        assert!(
            !parse_lockfile("requirements.txt", text).unwrap().complete,
            "{text}"
        );
    }
}

#[test]
fn dependency_diff_only_contains_changed_head_versions() {
    let base = parse_lockfile("requirements.txt", "requests==2.31.0\npytest==8.3.4\n").unwrap();
    let head = parse_lockfile("requirements.txt", "requests==2.32.3\npytest==8.3.4\n").unwrap();
    assert_eq!(
        head.changed_packages(&base),
        BTreeSet::from([(Ecosystem::PyPi, "requests".into(), "2.32.3".into())])
    );
}

#[test]
fn recorded_uv_graph_retains_real_transitive_resolutions_and_dev_groups() {
    let graph = parse_lockfile("uv.lock", &fixture("recorded-uv.lock")).unwrap();
    assert!(graph.complete, "{:?}", graph.notes);
    assert_eq!(graph.nodes["requests"].dependencies.len(), 4);
    assert!(graph.nodes["iniconfig"].flags.dev);
    let mut env = python_environment();
    env.omit_dev = true;
    let effective = graph.effective(".", &env).unwrap();
    assert!(effective.nodes["requests"].required);
    assert!(effective.nodes["idna"].required); // production and optional routes
    assert!(!effective.nodes["iniconfig"].required);
}

#[test]
fn extras_requested_by_a_dependency_activate_only_that_packages_extra_edges() {
    let graph = parse_lockfile(
        "uv.lock",
        r#"
version = 1
[[package]]
name = "app"
version = "1.0.0"
source = {virtual = "."}
dependencies = [{name = "requests", extra = ["socks"]}]
[[package]]
name = "requests"
version = "2.32.3"
[package.optional-dependencies]
socks = [{name = "pysocks"}]
[[package]]
name = "pysocks"
version = "1.7.1"
"#,
    )
    .unwrap();
    let effective = graph.effective(".", &python_environment()).unwrap();
    assert!(effective.nodes["requests"].required);
    assert!(effective.nodes["pysocks"].required);
    let requirements = parse_lockfile("requirements.txt", "requests[security]==2.32.3").unwrap();
    assert!(
        requirements
            .effective(".", &python_environment())
            .unwrap()
            .nodes["requests"]
            .required
    );
}

#[test]
fn recorded_python_lockfiles_and_exported_requirements_preserve_exact_pins() {
    for (recorded, format) in [
        ("recorded-uv.lock", "uv.lock"),
        ("recorded-poetry.lock", "poetry.lock"),
        ("recorded-Pipfile.lock", "Pipfile.lock"),
        ("requirements-recorded.txt", "requirements.txt"),
    ] {
        let graph = parse_lockfile(format, &fixture(recorded)).unwrap();
        assert!(graph.complete, "{recorded}: {:?}", graph.notes);
        assert!(
            graph
                .flattened()
                .contains(&(Ecosystem::PyPi, "requests".into(), "2.32.3".into()))
        );
        let effective = graph.effective(".", &python_environment()).unwrap();
        assert!(effective.nodes["requests"].required, "{recorded}");
    }
}

#[test]
fn poetry_group_markers_and_version_alternatives_are_platform_aware() {
    let graph = parse_lockfile(
        "poetry.lock",
        r#"
[[package]]
name = "parent"
version = "1.0.0"
groups = ["main"]
[package.dependencies]
child = "^2.1"
[[package]]
name = "child"
version = "2.2.0"
groups = ["main"]
markers = {main = "sys_platform == 'linux'"}
[[package]]
name = "child"
version = "3.1.0"
groups = ["dev"]
markers = {dev = "sys_platform == 'win32'"}
"#,
    )
    .unwrap();
    assert_eq!(graph.nodes["parent"].dependencies.len(), 1);
    assert_eq!(graph.nodes["parent"].dependencies[0].target, "child==2.2.0");
    let effective = graph.effective(".", &python_environment()).unwrap();
    assert!(effective.nodes.contains_key("child==2.2.0"));
    assert!(!effective.nodes.contains_key("child==3.1.0"));
}

#[test]
fn pnpm_bootstrap_document_does_not_replace_project_dependencies() {
    let lock = "---\nlockfileVersion: '9.0'\nimporters: {.: {configDependencies: {}}}\n---\nlockfileVersion: '9.0'\nimporters: {.: {dependencies: {foo: {version: 1.0.0}}}}\npackages: {foo@1.0.0: {}}\nsnapshots: {foo@1.0.0: {}}\n";
    for content in [
        lock.to_owned(),
        format!("\u{feff}{}", lock.replace('\n', "\r\n")),
    ] {
        let graph = rio_adapters::parse_lockfile("pnpm-lock.yaml", &content).unwrap();
        assert!(graph.complete);
        assert_eq!(graph.importers["."].dependencies[0].target, "foo@1.0.0");
    }
}
