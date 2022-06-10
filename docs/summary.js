(() => {
  const loadAndRender = async () => {
    try {
      status.innerText = "fetching";
      const url = `https://folioflakinessdashboard.blob.core.windows.net/dashboards/compressed_v1/${encodeURIComponent(
        commit
      )}.json`;
      const json = await fetch(url)
        .then((r) => {
          if (r.status !== 200)
            throw new Error(`[${url}]: Expected 200, but got ${r.status}`);
          return r;
        })
        .then((r) => r.json());
      status.innerText = "fetched";

      function getTestName(test) {
        const browserName = test.parameters.browserName || "N/A";
        const browserVersion = test.parameters.browserVersion || "";
        const platform = test.parameters.platform;
        const prefix =
          browserName && browserVersion
            ? browserName + " " + browserVersion
            : browserName;
        return [
          prefix,
          platform,
          ...Object.entries(test.parameters)
            .filter(
              ([key, value]) =>
                !!value &&
                key !== "platform" &&
                key !== "browserName" &&
                key !== "browserVersion"
            )
            .map(([key, value]) => {
              if (typeof value === "string") return value;
              if (typeof value === "boolean") return key;
              return `${key}=${value}`;
            }),
        ].join(" / ");
      }

      function getTestCategory(test) {
        const hasGoodRun = test.runs[test.expectedStatus] > 0;
        const hasBadRun =
          (test.expectedStatus !== "failed" && test.runs.failed > 0) ||
          (test.expectedStatus !== "timedOut" && test.runs.timedOut > 0);
        if (hasGoodRun && hasBadRun) return "flaky";
        if (hasBadRun) return "bad";
        return "good";
      }

      const CATEGORY_PRECEDENCE = ["bad", "flaky", "good"];

      function nextCategory(prev, current) {
        if (prev === "bad" || current === "bad") return "bad";
        if (prev === "flaky" || current === "flaky") return "flaky";
        if (current !== "good") throw new Error("unreachable");

        return "good";
      }

      const aggregate = (json, commit) => {
        const specs = [];
        const tests = [];
        const configurations = new Set();

        for (const entry of json) {
          for (const spec of entry.specs) {
            const specId = entry.file + "---" + spec.title;
            const specObject = {
              specId,
              file: entry.file,
              title: spec.title,
              line: spec.line,
              column: spec.column,
              configurationToTest: {},
            };
            specs.push(specObject);
            for (const test of spec.tests || []) {
              if (test.parameters.channel) {
                test.parameters.browserName = test.parameters.channel;
                delete test.parameters.channel;
              }
              // By default, all tests are run under "default" mode unless marked differently.
              if (!test.parameters.mode) test.parameters.mode = "default";

              // Cleanup a bunch of values that we don't use.
              delete test.parameters["timestamp"];
              delete test.parameters["ci.link"];
              delete test.parameters["revision.id"];
              delete test.parameters["revision.author"];
              delete test.parameters["revision.email"];
              delete test.parameters["revision.subject"];
              delete test.parameters["revision.timestamp"];
              delete test.parameters["revision.link"];
              const testObject = {
                specId,
                // spec: specObject,
                name: getTestName(test),
                browserName: test.parameters.browserName || "N/A",
                platform: test.parameters.platform,
                parameters: test.parameters,
                annotations: test.annotations || [],
                runs: {
                  passed: test.passed || 0,
                  skipped: test.skipped || 0,
                  timedOut: test.timedOut || 0,
                  failed: test.failed ? test.failed.length : 0,
                },
                errors: (test.failed || []).map((error) => ({
                  // Sometimes we get an error object like this:
                  // { "value: "Worker process exited unexpectedly" }
                  stack: error.stack || error.value,
                  // errorId: humanId(createStackSignature(error.stack || error.message || error.value)),
                })),
                hasErrors: test.failed?.length > 0,
                maxTime: test.maxTime, // max time with test passing
                expectedStatus: test.expectedStatus || "passed",
              };
              testObject.category = getTestCategory(testObject);
              tests.push(testObject);
              if (specObject.configurationToTest[testObject.name])
                throw new Error(
                  `Duplicate test for ${
                    testObject.name
                  }\nNEW:\n\n${JSON.stringify(
                    { testObject },
                    null,
                    " "
                  )}\nOLD:\n\n${JSON.stringify(
                    specObject.configurationToTest[testObject.name],
                    null,
                    " "
                  )}`
                );
              specObject.configurationToTest[testObject.name] = testObject;
              // for (const [name, value] of Object.entries(test.parameters)) {
              //   let values = this._testParameters.get(name);
              //   if (!values) {
              //     values = new Set();
              //     this._testParameters.set(name, values);
              //   }
              //   values.add(value);
              // }
            }

            specObject.category = "good";
            for (const [, { category: testCategory }] of Object.entries(
              specObject.configurationToTest
            ))
              specObject.category = nextCategory(
                specObject.category,
                testCategory
              );
          }
        }

        for (const test of tests) configurations.add(test.name);

        // console.log([...configurations].sort())

        // for (const spec of specs) {
        //   console.log(spec.file, spec.title);
        // }

        // console.assert(specs.length === new Set(specs.map(s => s.file + s.title)).size);
        // console.assert(specs.length === new Set(specs.map(s => [s.file, s.title, s.line, s.column].join(':'))).size);

        const toConfig = (name) => {
          const category = specs
            .map((s) => s.configurationToTest[name] || null)
            .filter(Boolean)
            .map((s) => s.category)
            .reduce(nextCategory, "good");
          return { name, category };
        };

        const configs = [...configurations].map(toConfig);
        configs.sort((a, b) => {
          const [aCategory, bCategory] = [
            CATEGORY_PRECEDENCE.indexOf(a.category),
            CATEGORY_PRECEDENCE.indexOf(b.category),
          ];
          if (aCategory !== bCategory) return aCategory < bCategory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        specs.sort((a, b) => {
          const [aCategory, bCategory] = [
            CATEGORY_PRECEDENCE.indexOf(a.category),
            CATEGORY_PRECEDENCE.indexOf(b.category),
          ];
          if (aCategory !== bCategory) return aCategory < bCategory ? -1 : 1;
          return a.specId.localeCompare(b.specId);
        });

        const matrix = [
          ["spec", ...configs],
          ...specs.map((s) => [
            s,
            ...configs
              .map((c) => c.name)
              .map((c) => s.configurationToTest[c] || null),
          ]),
        ];

        return matrix;
      };

      const table = document.createElement("table");
      const [config, ...specRows] = aggregate(json);

      const thead = document.createElement("thead");
      table.appendChild(thead);
      const tr = document.createElement("tr");
      thead.appendChild(tr);
      for (const header of config) {
        const th = document.createElement("th");
        tr.appendChild(th);
        if (typeof header === "string") {
          th.innerText = header;
        } else {
          th.innerText = header.name;
          th.classList.add(`category__${header.category}`, "vertical");
        }
      }

      const tbody = document.createElement("tbody");
      table.appendChild(tbody);
      for (const specRow of specRows) {
        const tr = document.createElement("tr");
        tbody.appendChild(tr);
        const [spec, ...tests] = specRow;

        const td = document.createElement("td");
        tr.appendChild(td);
        td.innerText = `${spec.file} > ${spec.title}`;
        td.classList.add(`category__${spec.category}`);

        for (const t of tests) {
          const category = t?.category || "-";
          const td = document.createElement("td");
          tr.appendChild(td);
          td.innerText = category[0].toUpperCase();
          td.classList.add(`category__${category}`);
        }
      }

      document.getElementById("root").appendChild(table);
      status.remove();
    } catch (e) {
      console.log(e);
      status.innerText = `ERROR\n${e}`;
    }
  };

  const url = new URL(window.location);
  let commit = url.searchParams.get("commit");

  const commitPicker = document.getElementById("picker");
  const pickerCommitEle = document.getElementById("picker__commit");
  const status = document.getElementById("status");

  commitPicker.addEventListener("close", () => {
    commit = pickerCommitEle.value;
    url.searchParams.set("commit", commit);
    window.history.pushState({}, "", url);
    loadAndRender();
  });

  if (!commit) {
    commitPicker.showModal();
    return;
  }

  loadAndRender();
})();
