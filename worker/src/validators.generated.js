"use strict";
export const profile = validate20;
const schema31 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://rio.dev/schemas/profile-v1.json",
  title: "Rio profile v1",
  type: "object",
  properties: {
    version: { const: 1 },
    name: { type: "string", minLength: 1 },
    extends: { type: "string", minLength: 1 },
    budget: {
      type: "object",
      properties: {
        fast: {
          type: "object",
          properties: {
            wall_time: {
              type: "string",
              pattern: "^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$",
            },
            tokens: { type: "integer", minimum: 1 },
            agents_max: { type: "integer", minimum: 1 },
            verify_tokens: { type: "integer", minimum: 1 },
          },
          required: [],
          additionalProperties: false,
        },
        deep: {
          type: "object",
          properties: {
            wall_time: {
              type: "string",
              pattern: "^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$",
            },
            tokens: { type: "integer", minimum: 1 },
            agents_max: { type: "integer", minimum: 1 },
            verify_tokens: { type: "integer", minimum: 1 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      required: [],
      additionalProperties: false,
    },
    models: {
      type: "object",
      additionalProperties: { type: "string", minLength: 1 },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          uses: { type: "string", minLength: 1 },
          needs: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
          parallel: { type: "boolean" },
          with: { type: "object" },
          rules: {
            type: "array",
            items: {
              type: "object",
              properties: {
                when: { type: "string", minLength: 1 },
                then: { type: "string", minLength: 1 },
              },
              required: ["when", "then"],
              additionalProperties: false,
            },
          },
          agents: {
            type: "array",
            items: {
              type: "object",
              minProperties: 1,
              maxProperties: 1,
              additionalProperties: {
                type: "object",
                properties: {
                  model: { type: "string", minLength: 1 },
                  run: { type: "boolean" },
                },
                required: ["model"],
              },
            },
          },
        },
        required: ["id", "uses"],
        additionalProperties: false,
      },
    },
    suppress: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            properties: { path: { type: "string", minLength: 1 } },
            required: ["path"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { rule: { type: "string", minLength: 1 } },
            required: ["rule"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { finding: { type: "string", minLength: 1 } },
            required: ["finding"],
            additionalProperties: false,
          },
        ],
      },
    },
    publish: { enum: ["never", "ask", "auto"] },
    fail_on: {
      type: "object",
      properties: {
        evidence: {
          enum: ["reproduced", "static_proven", "plausible", "refuted"],
        },
        categories: {
          type: "array",
          items: { enum: ["defect", "risk", "security"] },
          uniqueItems: true,
        },
        states: {
          type: "array",
          items: {
            enum: ["new", "worsened", "pre-existing", "fixed", "unclassified"],
          },
          uniqueItems: true,
        },
        rules: { type: "array", items: { type: "string", minLength: 1 } },
        incomplete: { type: "boolean" },
        required_checks: {
          type: "array",
          items: {
            enum: ["typecheck", "lint", "secrets", "coverage", "dependencies"],
          },
          uniqueItems: true,
        },
      },
      required: [],
      additionalProperties: false,
    },
    min_evidence: {
      enum: ["reproduced", "static_proven", "plausible", "refuted"],
    },
    max_lines: { type: "integer", minimum: 1 },
    posture: {
      enum: ["critical-only", "balanced", "thorough"],
      default: "balanced",
    },
    max_defects: { type: "integer", minimum: 1, default: 5 },
    rounds: {
      type: "object",
      properties: {
        cap: { type: "integer", minimum: 1, default: 3 },
        diff_only_after: { type: "integer", minimum: 0, default: 1 },
      },
      additionalProperties: false,
      default: { cap: 3, diff_only_after: 1 },
    },
    always_human: { type: "array", items: { type: "string" }, default: [] },
    verify: {
      type: "object",
      properties: {
        voters: { type: "integer", minimum: 1, default: 3 },
        quorum: { type: "integer", minimum: 1 },
        model: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  required: ["version", "name"],
  additionalProperties: false,
};
const func1 = Object.prototype.hasOwnProperty;
const func2 = require("ajv/dist/runtime/ucs2length").default;
const func0 = require("ajv/dist/runtime/equal").default;
const pattern4 = new RegExp("^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$", "u");
function validate20(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  /*# sourceURL="https://rio.dev/schemas/profile-v1.json" */ let vErrors = null;
  let errors = 0;
  const evaluated0 = validate20.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.version === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "version" },
        message: "must have required property '" + "version" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.name === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "name" },
        message: "must have required property '" + "name" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema31.properties, key0)) {
        const err2 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.version !== undefined) {
      if (1 !== data.version) {
        const err3 = {
          instancePath: instancePath + "/version",
          schemaPath: "#/properties/version/const",
          keyword: "const",
          params: { allowedValue: 1 },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.name !== undefined) {
      let data1 = data.name;
      if (typeof data1 === "string") {
        if (func2(data1) < 1) {
          const err4 = {
            instancePath: instancePath + "/name",
            schemaPath: "#/properties/name/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
      } else {
        const err5 = {
          instancePath: instancePath + "/name",
          schemaPath: "#/properties/name/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.extends !== undefined) {
      let data2 = data.extends;
      if (typeof data2 === "string") {
        if (func2(data2) < 1) {
          const err6 = {
            instancePath: instancePath + "/extends",
            schemaPath: "#/properties/extends/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
      } else {
        const err7 = {
          instancePath: instancePath + "/extends",
          schemaPath: "#/properties/extends/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.budget !== undefined) {
      let data3 = data.budget;
      if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
        for (const key1 in data3) {
          if (!(key1 === "fast" || key1 === "deep")) {
            const err8 = {
              instancePath: instancePath + "/budget",
              schemaPath: "#/properties/budget/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key1 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err8];
            } else {
              vErrors.push(err8);
            }
            errors++;
          }
        }
        if (data3.fast !== undefined) {
          let data4 = data3.fast;
          if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
            for (const key2 in data4) {
              if (!(
                key2 === "wall_time" ||
                key2 === "tokens" ||
                key2 === "agents_max" ||
                key2 === "verify_tokens"
              )) {
                const err9 = {
                  instancePath: instancePath + "/budget/fast",
                  schemaPath:
                    "#/properties/budget/properties/fast/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key2 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err9];
                } else {
                  vErrors.push(err9);
                }
                errors++;
              }
            }
            if (data4.wall_time !== undefined) {
              let data5 = data4.wall_time;
              if (typeof data5 === "string") {
                if (!pattern4.test(data5)) {
                  const err10 = {
                    instancePath: instancePath + "/budget/fast/wall_time",
                    schemaPath:
                      "#/properties/budget/properties/fast/properties/wall_time/pattern",
                    keyword: "pattern",
                    params: { pattern: "^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$" },
                    message:
                      'must match pattern "' +
                      "^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$" +
                      '"',
                  };
                  if (vErrors === null) {
                    vErrors = [err10];
                  } else {
                    vErrors.push(err10);
                  }
                  errors++;
                }
              } else {
                const err11 = {
                  instancePath: instancePath + "/budget/fast/wall_time",
                  schemaPath:
                    "#/properties/budget/properties/fast/properties/wall_time/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err11];
                } else {
                  vErrors.push(err11);
                }
                errors++;
              }
            }
            if (data4.tokens !== undefined) {
              let data6 = data4.tokens;
              if (!(
                typeof data6 == "number" &&
                !(data6 % 1) &&
                !isNaN(data6)
              )) {
                const err12 = {
                  instancePath: instancePath + "/budget/fast/tokens",
                  schemaPath:
                    "#/properties/budget/properties/fast/properties/tokens/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err12];
                } else {
                  vErrors.push(err12);
                }
                errors++;
              }
              if (typeof data6 == "number") {
                if (data6 < 1 || isNaN(data6)) {
                  const err13 = {
                    instancePath: instancePath + "/budget/fast/tokens",
                    schemaPath:
                      "#/properties/budget/properties/fast/properties/tokens/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err13];
                  } else {
                    vErrors.push(err13);
                  }
                  errors++;
                }
              }
            }
            if (data4.agents_max !== undefined) {
              let data7 = data4.agents_max;
              if (!(
                typeof data7 == "number" &&
                !(data7 % 1) &&
                !isNaN(data7)
              )) {
                const err14 = {
                  instancePath: instancePath + "/budget/fast/agents_max",
                  schemaPath:
                    "#/properties/budget/properties/fast/properties/agents_max/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err14];
                } else {
                  vErrors.push(err14);
                }
                errors++;
              }
              if (typeof data7 == "number") {
                if (data7 < 1 || isNaN(data7)) {
                  const err15 = {
                    instancePath: instancePath + "/budget/fast/agents_max",
                    schemaPath:
                      "#/properties/budget/properties/fast/properties/agents_max/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err15];
                  } else {
                    vErrors.push(err15);
                  }
                  errors++;
                }
              }
            }
            if (data4.verify_tokens !== undefined) {
              let data8 = data4.verify_tokens;
              if (!(
                typeof data8 == "number" &&
                !(data8 % 1) &&
                !isNaN(data8)
              )) {
                const err16 = {
                  instancePath: instancePath + "/budget/fast/verify_tokens",
                  schemaPath:
                    "#/properties/budget/properties/fast/properties/verify_tokens/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err16];
                } else {
                  vErrors.push(err16);
                }
                errors++;
              }
              if (typeof data8 == "number") {
                if (data8 < 1 || isNaN(data8)) {
                  const err17 = {
                    instancePath: instancePath + "/budget/fast/verify_tokens",
                    schemaPath:
                      "#/properties/budget/properties/fast/properties/verify_tokens/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err17];
                  } else {
                    vErrors.push(err17);
                  }
                  errors++;
                }
              }
            }
          } else {
            const err18 = {
              instancePath: instancePath + "/budget/fast",
              schemaPath: "#/properties/budget/properties/fast/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
        if (data3.deep !== undefined) {
          let data9 = data3.deep;
          if (data9 && typeof data9 == "object" && !Array.isArray(data9)) {
            for (const key3 in data9) {
              if (!(
                key3 === "wall_time" ||
                key3 === "tokens" ||
                key3 === "agents_max" ||
                key3 === "verify_tokens"
              )) {
                const err19 = {
                  instancePath: instancePath + "/budget/deep",
                  schemaPath:
                    "#/properties/budget/properties/deep/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key3 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err19];
                } else {
                  vErrors.push(err19);
                }
                errors++;
              }
            }
            if (data9.wall_time !== undefined) {
              let data10 = data9.wall_time;
              if (typeof data10 === "string") {
                if (!pattern4.test(data10)) {
                  const err20 = {
                    instancePath: instancePath + "/budget/deep/wall_time",
                    schemaPath:
                      "#/properties/budget/properties/deep/properties/wall_time/pattern",
                    keyword: "pattern",
                    params: { pattern: "^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$" },
                    message:
                      'must match pattern "' +
                      "^([0-9]+(\\.[0-9]+)?)(ms|s|m|h|d)$" +
                      '"',
                  };
                  if (vErrors === null) {
                    vErrors = [err20];
                  } else {
                    vErrors.push(err20);
                  }
                  errors++;
                }
              } else {
                const err21 = {
                  instancePath: instancePath + "/budget/deep/wall_time",
                  schemaPath:
                    "#/properties/budget/properties/deep/properties/wall_time/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err21];
                } else {
                  vErrors.push(err21);
                }
                errors++;
              }
            }
            if (data9.tokens !== undefined) {
              let data11 = data9.tokens;
              if (!(
                typeof data11 == "number" &&
                !(data11 % 1) &&
                !isNaN(data11)
              )) {
                const err22 = {
                  instancePath: instancePath + "/budget/deep/tokens",
                  schemaPath:
                    "#/properties/budget/properties/deep/properties/tokens/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err22];
                } else {
                  vErrors.push(err22);
                }
                errors++;
              }
              if (typeof data11 == "number") {
                if (data11 < 1 || isNaN(data11)) {
                  const err23 = {
                    instancePath: instancePath + "/budget/deep/tokens",
                    schemaPath:
                      "#/properties/budget/properties/deep/properties/tokens/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err23];
                  } else {
                    vErrors.push(err23);
                  }
                  errors++;
                }
              }
            }
            if (data9.agents_max !== undefined) {
              let data12 = data9.agents_max;
              if (!(
                typeof data12 == "number" &&
                !(data12 % 1) &&
                !isNaN(data12)
              )) {
                const err24 = {
                  instancePath: instancePath + "/budget/deep/agents_max",
                  schemaPath:
                    "#/properties/budget/properties/deep/properties/agents_max/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err24];
                } else {
                  vErrors.push(err24);
                }
                errors++;
              }
              if (typeof data12 == "number") {
                if (data12 < 1 || isNaN(data12)) {
                  const err25 = {
                    instancePath: instancePath + "/budget/deep/agents_max",
                    schemaPath:
                      "#/properties/budget/properties/deep/properties/agents_max/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err25];
                  } else {
                    vErrors.push(err25);
                  }
                  errors++;
                }
              }
            }
            if (data9.verify_tokens !== undefined) {
              let data13 = data9.verify_tokens;
              if (!(
                typeof data13 == "number" &&
                !(data13 % 1) &&
                !isNaN(data13)
              )) {
                const err26 = {
                  instancePath: instancePath + "/budget/deep/verify_tokens",
                  schemaPath:
                    "#/properties/budget/properties/deep/properties/verify_tokens/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err26];
                } else {
                  vErrors.push(err26);
                }
                errors++;
              }
              if (typeof data13 == "number") {
                if (data13 < 1 || isNaN(data13)) {
                  const err27 = {
                    instancePath: instancePath + "/budget/deep/verify_tokens",
                    schemaPath:
                      "#/properties/budget/properties/deep/properties/verify_tokens/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err27];
                  } else {
                    vErrors.push(err27);
                  }
                  errors++;
                }
              }
            }
          } else {
            const err28 = {
              instancePath: instancePath + "/budget/deep",
              schemaPath: "#/properties/budget/properties/deep/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err28];
            } else {
              vErrors.push(err28);
            }
            errors++;
          }
        }
      } else {
        const err29 = {
          instancePath: instancePath + "/budget",
          schemaPath: "#/properties/budget/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err29];
        } else {
          vErrors.push(err29);
        }
        errors++;
      }
    }
    if (data.models !== undefined) {
      let data14 = data.models;
      if (data14 && typeof data14 == "object" && !Array.isArray(data14)) {
        for (const key4 in data14) {
          let data15 = data14[key4];
          if (typeof data15 === "string") {
            if (func2(data15) < 1) {
              const err30 = {
                instancePath:
                  instancePath +
                  "/models/" +
                  key4.replace(/~/g, "~0").replace(/\//g, "~1"),
                schemaPath:
                  "#/properties/models/additionalProperties/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err30];
              } else {
                vErrors.push(err30);
              }
              errors++;
            }
          } else {
            const err31 = {
              instancePath:
                instancePath +
                "/models/" +
                key4.replace(/~/g, "~0").replace(/\//g, "~1"),
              schemaPath: "#/properties/models/additionalProperties/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err31];
            } else {
              vErrors.push(err31);
            }
            errors++;
          }
        }
      } else {
        const err32 = {
          instancePath: instancePath + "/models",
          schemaPath: "#/properties/models/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err32];
        } else {
          vErrors.push(err32);
        }
        errors++;
      }
    }
    if (data.steps !== undefined) {
      let data16 = data.steps;
      if (Array.isArray(data16)) {
        const len0 = data16.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data17 = data16[i0];
          if (data17 && typeof data17 == "object" && !Array.isArray(data17)) {
            if (data17.id === undefined) {
              const err33 = {
                instancePath: instancePath + "/steps/" + i0,
                schemaPath: "#/properties/steps/items/required",
                keyword: "required",
                params: { missingProperty: "id" },
                message: "must have required property '" + "id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err33];
              } else {
                vErrors.push(err33);
              }
              errors++;
            }
            if (data17.uses === undefined) {
              const err34 = {
                instancePath: instancePath + "/steps/" + i0,
                schemaPath: "#/properties/steps/items/required",
                keyword: "required",
                params: { missingProperty: "uses" },
                message: "must have required property '" + "uses" + "'",
              };
              if (vErrors === null) {
                vErrors = [err34];
              } else {
                vErrors.push(err34);
              }
              errors++;
            }
            for (const key5 in data17) {
              if (!(
                key5 === "id" ||
                key5 === "uses" ||
                key5 === "needs" ||
                key5 === "parallel" ||
                key5 === "with" ||
                key5 === "rules" ||
                key5 === "agents"
              )) {
                const err35 = {
                  instancePath: instancePath + "/steps/" + i0,
                  schemaPath: "#/properties/steps/items/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key5 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err35];
                } else {
                  vErrors.push(err35);
                }
                errors++;
              }
            }
            if (data17.id !== undefined) {
              let data18 = data17.id;
              if (typeof data18 === "string") {
                if (func2(data18) < 1) {
                  const err36 = {
                    instancePath: instancePath + "/steps/" + i0 + "/id",
                    schemaPath:
                      "#/properties/steps/items/properties/id/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err36];
                  } else {
                    vErrors.push(err36);
                  }
                  errors++;
                }
              } else {
                const err37 = {
                  instancePath: instancePath + "/steps/" + i0 + "/id",
                  schemaPath: "#/properties/steps/items/properties/id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err37];
                } else {
                  vErrors.push(err37);
                }
                errors++;
              }
            }
            if (data17.uses !== undefined) {
              let data19 = data17.uses;
              if (typeof data19 === "string") {
                if (func2(data19) < 1) {
                  const err38 = {
                    instancePath: instancePath + "/steps/" + i0 + "/uses",
                    schemaPath:
                      "#/properties/steps/items/properties/uses/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err38];
                  } else {
                    vErrors.push(err38);
                  }
                  errors++;
                }
              } else {
                const err39 = {
                  instancePath: instancePath + "/steps/" + i0 + "/uses",
                  schemaPath: "#/properties/steps/items/properties/uses/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err39];
                } else {
                  vErrors.push(err39);
                }
                errors++;
              }
            }
            if (data17.needs !== undefined) {
              let data20 = data17.needs;
              if (Array.isArray(data20)) {
                const len1 = data20.length;
                for (let i1 = 0; i1 < len1; i1++) {
                  let data21 = data20[i1];
                  if (typeof data21 === "string") {
                    if (func2(data21) < 1) {
                      const err40 = {
                        instancePath:
                          instancePath + "/steps/" + i0 + "/needs/" + i1,
                        schemaPath:
                          "#/properties/steps/items/properties/needs/items/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err40];
                      } else {
                        vErrors.push(err40);
                      }
                      errors++;
                    }
                  } else {
                    const err41 = {
                      instancePath:
                        instancePath + "/steps/" + i0 + "/needs/" + i1,
                      schemaPath:
                        "#/properties/steps/items/properties/needs/items/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err41];
                    } else {
                      vErrors.push(err41);
                    }
                    errors++;
                  }
                }
                let i2 = data20.length;
                let j0;
                if (i2 > 1) {
                  const indices0 = {};
                  for (; i2--;) {
                    let item0 = data20[i2];
                    if (typeof item0 !== "string") {
                      continue;
                    }
                    if (typeof indices0[item0] == "number") {
                      j0 = indices0[item0];
                      const err42 = {
                        instancePath: instancePath + "/steps/" + i0 + "/needs",
                        schemaPath:
                          "#/properties/steps/items/properties/needs/uniqueItems",
                        keyword: "uniqueItems",
                        params: { i: i2, j: j0 },
                        message:
                          "must NOT have duplicate items (items ## " +
                          j0 +
                          " and " +
                          i2 +
                          " are identical)",
                      };
                      if (vErrors === null) {
                        vErrors = [err42];
                      } else {
                        vErrors.push(err42);
                      }
                      errors++;
                      break;
                    }
                    indices0[item0] = i2;
                  }
                }
              } else {
                const err43 = {
                  instancePath: instancePath + "/steps/" + i0 + "/needs",
                  schemaPath: "#/properties/steps/items/properties/needs/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err43];
                } else {
                  vErrors.push(err43);
                }
                errors++;
              }
            }
            if (data17.parallel !== undefined) {
              if (typeof data17.parallel !== "boolean") {
                const err44 = {
                  instancePath: instancePath + "/steps/" + i0 + "/parallel",
                  schemaPath:
                    "#/properties/steps/items/properties/parallel/type",
                  keyword: "type",
                  params: { type: "boolean" },
                  message: "must be boolean",
                };
                if (vErrors === null) {
                  vErrors = [err44];
                } else {
                  vErrors.push(err44);
                }
                errors++;
              }
            }
            if (data17.with !== undefined) {
              let data23 = data17.with;
              if (!(
                data23 &&
                typeof data23 == "object" &&
                !Array.isArray(data23)
              )) {
                const err45 = {
                  instancePath: instancePath + "/steps/" + i0 + "/with",
                  schemaPath: "#/properties/steps/items/properties/with/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err45];
                } else {
                  vErrors.push(err45);
                }
                errors++;
              }
            }
            if (data17.rules !== undefined) {
              let data24 = data17.rules;
              if (Array.isArray(data24)) {
                const len2 = data24.length;
                for (let i3 = 0; i3 < len2; i3++) {
                  let data25 = data24[i3];
                  if (
                    data25 &&
                    typeof data25 == "object" &&
                    !Array.isArray(data25)
                  ) {
                    if (data25.when === undefined) {
                      const err46 = {
                        instancePath:
                          instancePath + "/steps/" + i0 + "/rules/" + i3,
                        schemaPath:
                          "#/properties/steps/items/properties/rules/items/required",
                        keyword: "required",
                        params: { missingProperty: "when" },
                        message: "must have required property '" + "when" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err46];
                      } else {
                        vErrors.push(err46);
                      }
                      errors++;
                    }
                    if (data25.then === undefined) {
                      const err47 = {
                        instancePath:
                          instancePath + "/steps/" + i0 + "/rules/" + i3,
                        schemaPath:
                          "#/properties/steps/items/properties/rules/items/required",
                        keyword: "required",
                        params: { missingProperty: "then" },
                        message: "must have required property '" + "then" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err47];
                      } else {
                        vErrors.push(err47);
                      }
                      errors++;
                    }
                    for (const key6 in data25) {
                      if (!(key6 === "when" || key6 === "then")) {
                        const err48 = {
                          instancePath:
                            instancePath + "/steps/" + i0 + "/rules/" + i3,
                          schemaPath:
                            "#/properties/steps/items/properties/rules/items/additionalProperties",
                          keyword: "additionalProperties",
                          params: { additionalProperty: key6 },
                          message: "must NOT have additional properties",
                        };
                        if (vErrors === null) {
                          vErrors = [err48];
                        } else {
                          vErrors.push(err48);
                        }
                        errors++;
                      }
                    }
                    if (data25.when !== undefined) {
                      let data26 = data25.when;
                      if (typeof data26 === "string") {
                        if (func2(data26) < 1) {
                          const err49 = {
                            instancePath:
                              instancePath +
                              "/steps/" +
                              i0 +
                              "/rules/" +
                              i3 +
                              "/when",
                            schemaPath:
                              "#/properties/steps/items/properties/rules/items/properties/when/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err49];
                          } else {
                            vErrors.push(err49);
                          }
                          errors++;
                        }
                      } else {
                        const err50 = {
                          instancePath:
                            instancePath +
                            "/steps/" +
                            i0 +
                            "/rules/" +
                            i3 +
                            "/when",
                          schemaPath:
                            "#/properties/steps/items/properties/rules/items/properties/when/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err50];
                        } else {
                          vErrors.push(err50);
                        }
                        errors++;
                      }
                    }
                    if (data25.then !== undefined) {
                      let data27 = data25.then;
                      if (typeof data27 === "string") {
                        if (func2(data27) < 1) {
                          const err51 = {
                            instancePath:
                              instancePath +
                              "/steps/" +
                              i0 +
                              "/rules/" +
                              i3 +
                              "/then",
                            schemaPath:
                              "#/properties/steps/items/properties/rules/items/properties/then/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err51];
                          } else {
                            vErrors.push(err51);
                          }
                          errors++;
                        }
                      } else {
                        const err52 = {
                          instancePath:
                            instancePath +
                            "/steps/" +
                            i0 +
                            "/rules/" +
                            i3 +
                            "/then",
                          schemaPath:
                            "#/properties/steps/items/properties/rules/items/properties/then/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err52];
                        } else {
                          vErrors.push(err52);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err53 = {
                      instancePath:
                        instancePath + "/steps/" + i0 + "/rules/" + i3,
                      schemaPath:
                        "#/properties/steps/items/properties/rules/items/type",
                      keyword: "type",
                      params: { type: "object" },
                      message: "must be object",
                    };
                    if (vErrors === null) {
                      vErrors = [err53];
                    } else {
                      vErrors.push(err53);
                    }
                    errors++;
                  }
                }
              } else {
                const err54 = {
                  instancePath: instancePath + "/steps/" + i0 + "/rules",
                  schemaPath: "#/properties/steps/items/properties/rules/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err54];
                } else {
                  vErrors.push(err54);
                }
                errors++;
              }
            }
            if (data17.agents !== undefined) {
              let data28 = data17.agents;
              if (Array.isArray(data28)) {
                const len3 = data28.length;
                for (let i4 = 0; i4 < len3; i4++) {
                  let data29 = data28[i4];
                  if (
                    data29 &&
                    typeof data29 == "object" &&
                    !Array.isArray(data29)
                  ) {
                    if (Object.keys(data29).length > 1) {
                      const err55 = {
                        instancePath:
                          instancePath + "/steps/" + i0 + "/agents/" + i4,
                        schemaPath:
                          "#/properties/steps/items/properties/agents/items/maxProperties",
                        keyword: "maxProperties",
                        params: { limit: 1 },
                        message: "must NOT have more than 1 properties",
                      };
                      if (vErrors === null) {
                        vErrors = [err55];
                      } else {
                        vErrors.push(err55);
                      }
                      errors++;
                    }
                    if (Object.keys(data29).length < 1) {
                      const err56 = {
                        instancePath:
                          instancePath + "/steps/" + i0 + "/agents/" + i4,
                        schemaPath:
                          "#/properties/steps/items/properties/agents/items/minProperties",
                        keyword: "minProperties",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 properties",
                      };
                      if (vErrors === null) {
                        vErrors = [err56];
                      } else {
                        vErrors.push(err56);
                      }
                      errors++;
                    }
                    for (const key7 in data29) {
                      let data30 = data29[key7];
                      if (
                        data30 &&
                        typeof data30 == "object" &&
                        !Array.isArray(data30)
                      ) {
                        if (data30.model === undefined) {
                          const err57 = {
                            instancePath:
                              instancePath +
                              "/steps/" +
                              i0 +
                              "/agents/" +
                              i4 +
                              "/" +
                              key7.replace(/~/g, "~0").replace(/\//g, "~1"),
                            schemaPath:
                              "#/properties/steps/items/properties/agents/items/additionalProperties/required",
                            keyword: "required",
                            params: { missingProperty: "model" },
                            message:
                              "must have required property '" + "model" + "'",
                          };
                          if (vErrors === null) {
                            vErrors = [err57];
                          } else {
                            vErrors.push(err57);
                          }
                          errors++;
                        }
                        if (data30.model !== undefined) {
                          let data31 = data30.model;
                          if (typeof data31 === "string") {
                            if (func2(data31) < 1) {
                              const err58 = {
                                instancePath:
                                  instancePath +
                                  "/steps/" +
                                  i0 +
                                  "/agents/" +
                                  i4 +
                                  "/" +
                                  key7
                                    .replace(/~/g, "~0")
                                    .replace(/\//g, "~1") +
                                  "/model",
                                schemaPath:
                                  "#/properties/steps/items/properties/agents/items/additionalProperties/properties/model/minLength",
                                keyword: "minLength",
                                params: { limit: 1 },
                                message:
                                  "must NOT have fewer than 1 characters",
                              };
                              if (vErrors === null) {
                                vErrors = [err58];
                              } else {
                                vErrors.push(err58);
                              }
                              errors++;
                            }
                          } else {
                            const err59 = {
                              instancePath:
                                instancePath +
                                "/steps/" +
                                i0 +
                                "/agents/" +
                                i4 +
                                "/" +
                                key7.replace(/~/g, "~0").replace(/\//g, "~1") +
                                "/model",
                              schemaPath:
                                "#/properties/steps/items/properties/agents/items/additionalProperties/properties/model/type",
                              keyword: "type",
                              params: { type: "string" },
                              message: "must be string",
                            };
                            if (vErrors === null) {
                              vErrors = [err59];
                            } else {
                              vErrors.push(err59);
                            }
                            errors++;
                          }
                        }
                        if (data30.run !== undefined) {
                          if (typeof data30.run !== "boolean") {
                            const err60 = {
                              instancePath:
                                instancePath +
                                "/steps/" +
                                i0 +
                                "/agents/" +
                                i4 +
                                "/" +
                                key7.replace(/~/g, "~0").replace(/\//g, "~1") +
                                "/run",
                              schemaPath:
                                "#/properties/steps/items/properties/agents/items/additionalProperties/properties/run/type",
                              keyword: "type",
                              params: { type: "boolean" },
                              message: "must be boolean",
                            };
                            if (vErrors === null) {
                              vErrors = [err60];
                            } else {
                              vErrors.push(err60);
                            }
                            errors++;
                          }
                        }
                      } else {
                        const err61 = {
                          instancePath:
                            instancePath +
                            "/steps/" +
                            i0 +
                            "/agents/" +
                            i4 +
                            "/" +
                            key7.replace(/~/g, "~0").replace(/\//g, "~1"),
                          schemaPath:
                            "#/properties/steps/items/properties/agents/items/additionalProperties/type",
                          keyword: "type",
                          params: { type: "object" },
                          message: "must be object",
                        };
                        if (vErrors === null) {
                          vErrors = [err61];
                        } else {
                          vErrors.push(err61);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err62 = {
                      instancePath:
                        instancePath + "/steps/" + i0 + "/agents/" + i4,
                      schemaPath:
                        "#/properties/steps/items/properties/agents/items/type",
                      keyword: "type",
                      params: { type: "object" },
                      message: "must be object",
                    };
                    if (vErrors === null) {
                      vErrors = [err62];
                    } else {
                      vErrors.push(err62);
                    }
                    errors++;
                  }
                }
              } else {
                const err63 = {
                  instancePath: instancePath + "/steps/" + i0 + "/agents",
                  schemaPath: "#/properties/steps/items/properties/agents/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err63];
                } else {
                  vErrors.push(err63);
                }
                errors++;
              }
            }
          } else {
            const err64 = {
              instancePath: instancePath + "/steps/" + i0,
              schemaPath: "#/properties/steps/items/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err64];
            } else {
              vErrors.push(err64);
            }
            errors++;
          }
        }
      } else {
        const err65 = {
          instancePath: instancePath + "/steps",
          schemaPath: "#/properties/steps/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err65];
        } else {
          vErrors.push(err65);
        }
        errors++;
      }
    }
    if (data.suppress !== undefined) {
      let data33 = data.suppress;
      if (Array.isArray(data33)) {
        const len4 = data33.length;
        for (let i5 = 0; i5 < len4; i5++) {
          let data34 = data33[i5];
          const _errs77 = errors;
          let valid20 = false;
          let passing0 = null;
          const _errs78 = errors;
          if (data34 && typeof data34 == "object" && !Array.isArray(data34)) {
            if (data34.path === undefined) {
              const err66 = {
                instancePath: instancePath + "/suppress/" + i5,
                schemaPath: "#/properties/suppress/items/oneOf/0/required",
                keyword: "required",
                params: { missingProperty: "path" },
                message: "must have required property '" + "path" + "'",
              };
              if (vErrors === null) {
                vErrors = [err66];
              } else {
                vErrors.push(err66);
              }
              errors++;
            }
            for (const key8 in data34) {
              if (!(key8 === "path")) {
                const err67 = {
                  instancePath: instancePath + "/suppress/" + i5,
                  schemaPath:
                    "#/properties/suppress/items/oneOf/0/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key8 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err67];
                } else {
                  vErrors.push(err67);
                }
                errors++;
              }
            }
            if (data34.path !== undefined) {
              let data35 = data34.path;
              if (typeof data35 === "string") {
                if (func2(data35) < 1) {
                  const err68 = {
                    instancePath: instancePath + "/suppress/" + i5 + "/path",
                    schemaPath:
                      "#/properties/suppress/items/oneOf/0/properties/path/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err68];
                  } else {
                    vErrors.push(err68);
                  }
                  errors++;
                }
              } else {
                const err69 = {
                  instancePath: instancePath + "/suppress/" + i5 + "/path",
                  schemaPath:
                    "#/properties/suppress/items/oneOf/0/properties/path/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err69];
                } else {
                  vErrors.push(err69);
                }
                errors++;
              }
            }
          } else {
            const err70 = {
              instancePath: instancePath + "/suppress/" + i5,
              schemaPath: "#/properties/suppress/items/oneOf/0/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err70];
            } else {
              vErrors.push(err70);
            }
            errors++;
          }
          var _valid0 = _errs78 === errors;
          if (_valid0) {
            valid20 = true;
            passing0 = 0;
            var props0 = true;
          }
          const _errs83 = errors;
          if (data34 && typeof data34 == "object" && !Array.isArray(data34)) {
            if (data34.rule === undefined) {
              const err71 = {
                instancePath: instancePath + "/suppress/" + i5,
                schemaPath: "#/properties/suppress/items/oneOf/1/required",
                keyword: "required",
                params: { missingProperty: "rule" },
                message: "must have required property '" + "rule" + "'",
              };
              if (vErrors === null) {
                vErrors = [err71];
              } else {
                vErrors.push(err71);
              }
              errors++;
            }
            for (const key9 in data34) {
              if (!(key9 === "rule")) {
                const err72 = {
                  instancePath: instancePath + "/suppress/" + i5,
                  schemaPath:
                    "#/properties/suppress/items/oneOf/1/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key9 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err72];
                } else {
                  vErrors.push(err72);
                }
                errors++;
              }
            }
            if (data34.rule !== undefined) {
              let data36 = data34.rule;
              if (typeof data36 === "string") {
                if (func2(data36) < 1) {
                  const err73 = {
                    instancePath: instancePath + "/suppress/" + i5 + "/rule",
                    schemaPath:
                      "#/properties/suppress/items/oneOf/1/properties/rule/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err73];
                  } else {
                    vErrors.push(err73);
                  }
                  errors++;
                }
              } else {
                const err74 = {
                  instancePath: instancePath + "/suppress/" + i5 + "/rule",
                  schemaPath:
                    "#/properties/suppress/items/oneOf/1/properties/rule/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err74];
                } else {
                  vErrors.push(err74);
                }
                errors++;
              }
            }
          } else {
            const err75 = {
              instancePath: instancePath + "/suppress/" + i5,
              schemaPath: "#/properties/suppress/items/oneOf/1/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err75];
            } else {
              vErrors.push(err75);
            }
            errors++;
          }
          var _valid0 = _errs83 === errors;
          if (_valid0 && valid20) {
            valid20 = false;
            passing0 = [passing0, 1];
          } else {
            if (_valid0) {
              valid20 = true;
              passing0 = 1;
              if (props0 !== true) {
                props0 = true;
              }
            }
            const _errs88 = errors;
            if (data34 && typeof data34 == "object" && !Array.isArray(data34)) {
              if (data34.finding === undefined) {
                const err76 = {
                  instancePath: instancePath + "/suppress/" + i5,
                  schemaPath: "#/properties/suppress/items/oneOf/2/required",
                  keyword: "required",
                  params: { missingProperty: "finding" },
                  message: "must have required property '" + "finding" + "'",
                };
                if (vErrors === null) {
                  vErrors = [err76];
                } else {
                  vErrors.push(err76);
                }
                errors++;
              }
              for (const key10 in data34) {
                if (!(key10 === "finding")) {
                  const err77 = {
                    instancePath: instancePath + "/suppress/" + i5,
                    schemaPath:
                      "#/properties/suppress/items/oneOf/2/additionalProperties",
                    keyword: "additionalProperties",
                    params: { additionalProperty: key10 },
                    message: "must NOT have additional properties",
                  };
                  if (vErrors === null) {
                    vErrors = [err77];
                  } else {
                    vErrors.push(err77);
                  }
                  errors++;
                }
              }
              if (data34.finding !== undefined) {
                let data37 = data34.finding;
                if (typeof data37 === "string") {
                  if (func2(data37) < 1) {
                    const err78 = {
                      instancePath:
                        instancePath + "/suppress/" + i5 + "/finding",
                      schemaPath:
                        "#/properties/suppress/items/oneOf/2/properties/finding/minLength",
                      keyword: "minLength",
                      params: { limit: 1 },
                      message: "must NOT have fewer than 1 characters",
                    };
                    if (vErrors === null) {
                      vErrors = [err78];
                    } else {
                      vErrors.push(err78);
                    }
                    errors++;
                  }
                } else {
                  const err79 = {
                    instancePath: instancePath + "/suppress/" + i5 + "/finding",
                    schemaPath:
                      "#/properties/suppress/items/oneOf/2/properties/finding/type",
                    keyword: "type",
                    params: { type: "string" },
                    message: "must be string",
                  };
                  if (vErrors === null) {
                    vErrors = [err79];
                  } else {
                    vErrors.push(err79);
                  }
                  errors++;
                }
              }
            } else {
              const err80 = {
                instancePath: instancePath + "/suppress/" + i5,
                schemaPath: "#/properties/suppress/items/oneOf/2/type",
                keyword: "type",
                params: { type: "object" },
                message: "must be object",
              };
              if (vErrors === null) {
                vErrors = [err80];
              } else {
                vErrors.push(err80);
              }
              errors++;
            }
            var _valid0 = _errs88 === errors;
            if (_valid0 && valid20) {
              valid20 = false;
              passing0 = [passing0, 2];
            } else {
              if (_valid0) {
                valid20 = true;
                passing0 = 2;
                if (props0 !== true) {
                  props0 = true;
                }
              }
            }
          }
          if (!valid20) {
            const err81 = {
              instancePath: instancePath + "/suppress/" + i5,
              schemaPath: "#/properties/suppress/items/oneOf",
              keyword: "oneOf",
              params: { passingSchemas: passing0 },
              message: "must match exactly one schema in oneOf",
            };
            if (vErrors === null) {
              vErrors = [err81];
            } else {
              vErrors.push(err81);
            }
            errors++;
          } else {
            errors = _errs77;
            if (vErrors !== null) {
              if (_errs77) {
                vErrors.length = _errs77;
              } else {
                vErrors = null;
              }
            }
          }
        }
      } else {
        const err82 = {
          instancePath: instancePath + "/suppress",
          schemaPath: "#/properties/suppress/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err82];
        } else {
          vErrors.push(err82);
        }
        errors++;
      }
    }
    if (data.publish !== undefined) {
      let data38 = data.publish;
      if (!(data38 === "never" || data38 === "ask" || data38 === "auto")) {
        const err83 = {
          instancePath: instancePath + "/publish",
          schemaPath: "#/properties/publish/enum",
          keyword: "enum",
          params: { allowedValues: schema31.properties.publish.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err83];
        } else {
          vErrors.push(err83);
        }
        errors++;
      }
    }
    if (data.fail_on !== undefined) {
      let data39 = data.fail_on;
      if (data39 && typeof data39 == "object" && !Array.isArray(data39)) {
        for (const key11 in data39) {
          if (!(
            key11 === "evidence" ||
            key11 === "categories" ||
            key11 === "states" ||
            key11 === "rules" ||
            key11 === "incomplete" ||
            key11 === "required_checks"
          )) {
            const err84 = {
              instancePath: instancePath + "/fail_on",
              schemaPath: "#/properties/fail_on/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key11 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err84];
            } else {
              vErrors.push(err84);
            }
            errors++;
          }
        }
        if (data39.evidence !== undefined) {
          let data40 = data39.evidence;
          if (!(
            data40 === "reproduced" ||
            data40 === "static_proven" ||
            data40 === "plausible" ||
            data40 === "refuted"
          )) {
            const err85 = {
              instancePath: instancePath + "/fail_on/evidence",
              schemaPath: "#/properties/fail_on/properties/evidence/enum",
              keyword: "enum",
              params: {
                allowedValues:
                  schema31.properties.fail_on.properties.evidence.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err85];
            } else {
              vErrors.push(err85);
            }
            errors++;
          }
        }
        if (data39.categories !== undefined) {
          let data41 = data39.categories;
          if (Array.isArray(data41)) {
            const len5 = data41.length;
            for (let i6 = 0; i6 < len5; i6++) {
              let data42 = data41[i6];
              if (!(
                data42 === "defect" ||
                data42 === "risk" ||
                data42 === "security"
              )) {
                const err86 = {
                  instancePath: instancePath + "/fail_on/categories/" + i6,
                  schemaPath:
                    "#/properties/fail_on/properties/categories/items/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema31.properties.fail_on.properties.categories.items
                        .enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err86];
                } else {
                  vErrors.push(err86);
                }
                errors++;
              }
            }
            let i7 = data41.length;
            let j1;
            if (i7 > 1) {
              outer0: for (; i7--;) {
                for (j1 = i7; j1--;) {
                  if (func0(data41[i7], data41[j1])) {
                    const err87 = {
                      instancePath: instancePath + "/fail_on/categories",
                      schemaPath:
                        "#/properties/fail_on/properties/categories/uniqueItems",
                      keyword: "uniqueItems",
                      params: { i: i7, j: j1 },
                      message:
                        "must NOT have duplicate items (items ## " +
                        j1 +
                        " and " +
                        i7 +
                        " are identical)",
                    };
                    if (vErrors === null) {
                      vErrors = [err87];
                    } else {
                      vErrors.push(err87);
                    }
                    errors++;
                    break outer0;
                  }
                }
              }
            }
          } else {
            const err88 = {
              instancePath: instancePath + "/fail_on/categories",
              schemaPath: "#/properties/fail_on/properties/categories/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err88];
            } else {
              vErrors.push(err88);
            }
            errors++;
          }
        }
        if (data39.states !== undefined) {
          let data43 = data39.states;
          if (Array.isArray(data43)) {
            const len6 = data43.length;
            for (let i8 = 0; i8 < len6; i8++) {
              let data44 = data43[i8];
              if (!(
                data44 === "new" ||
                data44 === "worsened" ||
                data44 === "pre-existing" ||
                data44 === "fixed" ||
                data44 === "unclassified"
              )) {
                const err89 = {
                  instancePath: instancePath + "/fail_on/states/" + i8,
                  schemaPath:
                    "#/properties/fail_on/properties/states/items/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema31.properties.fail_on.properties.states.items.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err89];
                } else {
                  vErrors.push(err89);
                }
                errors++;
              }
            }
            let i9 = data43.length;
            let j2;
            if (i9 > 1) {
              outer1: for (; i9--;) {
                for (j2 = i9; j2--;) {
                  if (func0(data43[i9], data43[j2])) {
                    const err90 = {
                      instancePath: instancePath + "/fail_on/states",
                      schemaPath:
                        "#/properties/fail_on/properties/states/uniqueItems",
                      keyword: "uniqueItems",
                      params: { i: i9, j: j2 },
                      message:
                        "must NOT have duplicate items (items ## " +
                        j2 +
                        " and " +
                        i9 +
                        " are identical)",
                    };
                    if (vErrors === null) {
                      vErrors = [err90];
                    } else {
                      vErrors.push(err90);
                    }
                    errors++;
                    break outer1;
                  }
                }
              }
            }
          } else {
            const err91 = {
              instancePath: instancePath + "/fail_on/states",
              schemaPath: "#/properties/fail_on/properties/states/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err91];
            } else {
              vErrors.push(err91);
            }
            errors++;
          }
        }
        if (data39.rules !== undefined) {
          let data45 = data39.rules;
          if (Array.isArray(data45)) {
            const len7 = data45.length;
            for (let i10 = 0; i10 < len7; i10++) {
              let data46 = data45[i10];
              if (typeof data46 === "string") {
                if (func2(data46) < 1) {
                  const err92 = {
                    instancePath: instancePath + "/fail_on/rules/" + i10,
                    schemaPath:
                      "#/properties/fail_on/properties/rules/items/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err92];
                  } else {
                    vErrors.push(err92);
                  }
                  errors++;
                }
              } else {
                const err93 = {
                  instancePath: instancePath + "/fail_on/rules/" + i10,
                  schemaPath:
                    "#/properties/fail_on/properties/rules/items/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err93];
                } else {
                  vErrors.push(err93);
                }
                errors++;
              }
            }
          } else {
            const err94 = {
              instancePath: instancePath + "/fail_on/rules",
              schemaPath: "#/properties/fail_on/properties/rules/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err94];
            } else {
              vErrors.push(err94);
            }
            errors++;
          }
        }
        if (data39.incomplete !== undefined) {
          if (typeof data39.incomplete !== "boolean") {
            const err95 = {
              instancePath: instancePath + "/fail_on/incomplete",
              schemaPath: "#/properties/fail_on/properties/incomplete/type",
              keyword: "type",
              params: { type: "boolean" },
              message: "must be boolean",
            };
            if (vErrors === null) {
              vErrors = [err95];
            } else {
              vErrors.push(err95);
            }
            errors++;
          }
        }
        if (data39.required_checks !== undefined) {
          let data48 = data39.required_checks;
          if (Array.isArray(data48)) {
            const len8 = data48.length;
            for (let i11 = 0; i11 < len8; i11++) {
              let data49 = data48[i11];
              if (!(
                data49 === "typecheck" ||
                data49 === "lint" ||
                data49 === "secrets" ||
                data49 === "coverage" ||
                data49 === "dependencies"
              )) {
                const err96 = {
                  instancePath:
                    instancePath + "/fail_on/required_checks/" + i11,
                  schemaPath:
                    "#/properties/fail_on/properties/required_checks/items/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema31.properties.fail_on.properties.required_checks
                        .items.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err96];
                } else {
                  vErrors.push(err96);
                }
                errors++;
              }
            }
            let i12 = data48.length;
            let j3;
            if (i12 > 1) {
              outer2: for (; i12--;) {
                for (j3 = i12; j3--;) {
                  if (func0(data48[i12], data48[j3])) {
                    const err97 = {
                      instancePath: instancePath + "/fail_on/required_checks",
                      schemaPath:
                        "#/properties/fail_on/properties/required_checks/uniqueItems",
                      keyword: "uniqueItems",
                      params: { i: i12, j: j3 },
                      message:
                        "must NOT have duplicate items (items ## " +
                        j3 +
                        " and " +
                        i12 +
                        " are identical)",
                    };
                    if (vErrors === null) {
                      vErrors = [err97];
                    } else {
                      vErrors.push(err97);
                    }
                    errors++;
                    break outer2;
                  }
                }
              }
            }
          } else {
            const err98 = {
              instancePath: instancePath + "/fail_on/required_checks",
              schemaPath:
                "#/properties/fail_on/properties/required_checks/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err98];
            } else {
              vErrors.push(err98);
            }
            errors++;
          }
        }
      } else {
        const err99 = {
          instancePath: instancePath + "/fail_on",
          schemaPath: "#/properties/fail_on/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err99];
        } else {
          vErrors.push(err99);
        }
        errors++;
      }
    }
    if (data.min_evidence !== undefined) {
      let data50 = data.min_evidence;
      if (!(
        data50 === "reproduced" ||
        data50 === "static_proven" ||
        data50 === "plausible" ||
        data50 === "refuted"
      )) {
        const err100 = {
          instancePath: instancePath + "/min_evidence",
          schemaPath: "#/properties/min_evidence/enum",
          keyword: "enum",
          params: { allowedValues: schema31.properties.min_evidence.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err100];
        } else {
          vErrors.push(err100);
        }
        errors++;
      }
    }
    if (data.max_lines !== undefined) {
      let data51 = data.max_lines;
      if (!(typeof data51 == "number" && !(data51 % 1) && !isNaN(data51))) {
        const err101 = {
          instancePath: instancePath + "/max_lines",
          schemaPath: "#/properties/max_lines/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err101];
        } else {
          vErrors.push(err101);
        }
        errors++;
      }
      if (typeof data51 == "number") {
        if (data51 < 1 || isNaN(data51)) {
          const err102 = {
            instancePath: instancePath + "/max_lines",
            schemaPath: "#/properties/max_lines/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 1 },
            message: "must be >= 1",
          };
          if (vErrors === null) {
            vErrors = [err102];
          } else {
            vErrors.push(err102);
          }
          errors++;
        }
      }
    }
    if (data.posture !== undefined) {
      let data52 = data.posture;
      if (!(
        data52 === "critical-only" ||
        data52 === "balanced" ||
        data52 === "thorough"
      )) {
        const err103 = {
          instancePath: instancePath + "/posture",
          schemaPath: "#/properties/posture/enum",
          keyword: "enum",
          params: { allowedValues: schema31.properties.posture.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err103];
        } else {
          vErrors.push(err103);
        }
        errors++;
      }
    }
    if (data.max_defects !== undefined) {
      let data53 = data.max_defects;
      if (!(typeof data53 == "number" && !(data53 % 1) && !isNaN(data53))) {
        const err104 = {
          instancePath: instancePath + "/max_defects",
          schemaPath: "#/properties/max_defects/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err104];
        } else {
          vErrors.push(err104);
        }
        errors++;
      }
      if (typeof data53 == "number") {
        if (data53 < 1 || isNaN(data53)) {
          const err105 = {
            instancePath: instancePath + "/max_defects",
            schemaPath: "#/properties/max_defects/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 1 },
            message: "must be >= 1",
          };
          if (vErrors === null) {
            vErrors = [err105];
          } else {
            vErrors.push(err105);
          }
          errors++;
        }
      }
    }
    if (data.rounds !== undefined) {
      let data54 = data.rounds;
      if (data54 && typeof data54 == "object" && !Array.isArray(data54)) {
        for (const key12 in data54) {
          if (!(key12 === "cap" || key12 === "diff_only_after")) {
            const err106 = {
              instancePath: instancePath + "/rounds",
              schemaPath: "#/properties/rounds/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key12 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err106];
            } else {
              vErrors.push(err106);
            }
            errors++;
          }
        }
        if (data54.cap !== undefined) {
          let data55 = data54.cap;
          if (!(typeof data55 == "number" && !(data55 % 1) && !isNaN(data55))) {
            const err107 = {
              instancePath: instancePath + "/rounds/cap",
              schemaPath: "#/properties/rounds/properties/cap/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err107];
            } else {
              vErrors.push(err107);
            }
            errors++;
          }
          if (typeof data55 == "number") {
            if (data55 < 1 || isNaN(data55)) {
              const err108 = {
                instancePath: instancePath + "/rounds/cap",
                schemaPath: "#/properties/rounds/properties/cap/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err108];
              } else {
                vErrors.push(err108);
              }
              errors++;
            }
          }
        }
        if (data54.diff_only_after !== undefined) {
          let data56 = data54.diff_only_after;
          if (!(typeof data56 == "number" && !(data56 % 1) && !isNaN(data56))) {
            const err109 = {
              instancePath: instancePath + "/rounds/diff_only_after",
              schemaPath: "#/properties/rounds/properties/diff_only_after/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err109];
            } else {
              vErrors.push(err109);
            }
            errors++;
          }
          if (typeof data56 == "number") {
            if (data56 < 0 || isNaN(data56)) {
              const err110 = {
                instancePath: instancePath + "/rounds/diff_only_after",
                schemaPath:
                  "#/properties/rounds/properties/diff_only_after/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err110];
              } else {
                vErrors.push(err110);
              }
              errors++;
            }
          }
        }
      } else {
        const err111 = {
          instancePath: instancePath + "/rounds",
          schemaPath: "#/properties/rounds/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err111];
        } else {
          vErrors.push(err111);
        }
        errors++;
      }
    }
    if (data.always_human !== undefined) {
      let data57 = data.always_human;
      if (Array.isArray(data57)) {
        const len9 = data57.length;
        for (let i13 = 0; i13 < len9; i13++) {
          if (typeof data57[i13] !== "string") {
            const err112 = {
              instancePath: instancePath + "/always_human/" + i13,
              schemaPath: "#/properties/always_human/items/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err112];
            } else {
              vErrors.push(err112);
            }
            errors++;
          }
        }
      } else {
        const err113 = {
          instancePath: instancePath + "/always_human",
          schemaPath: "#/properties/always_human/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err113];
        } else {
          vErrors.push(err113);
        }
        errors++;
      }
    }
    if (data.verify !== undefined) {
      let data59 = data.verify;
      if (data59 && typeof data59 == "object" && !Array.isArray(data59)) {
        for (const key13 in data59) {
          if (!(
            key13 === "voters" ||
            key13 === "quorum" ||
            key13 === "model"
          )) {
            const err114 = {
              instancePath: instancePath + "/verify",
              schemaPath: "#/properties/verify/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key13 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err114];
            } else {
              vErrors.push(err114);
            }
            errors++;
          }
        }
        if (data59.voters !== undefined) {
          let data60 = data59.voters;
          if (!(typeof data60 == "number" && !(data60 % 1) && !isNaN(data60))) {
            const err115 = {
              instancePath: instancePath + "/verify/voters",
              schemaPath: "#/properties/verify/properties/voters/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err115];
            } else {
              vErrors.push(err115);
            }
            errors++;
          }
          if (typeof data60 == "number") {
            if (data60 < 1 || isNaN(data60)) {
              const err116 = {
                instancePath: instancePath + "/verify/voters",
                schemaPath: "#/properties/verify/properties/voters/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err116];
              } else {
                vErrors.push(err116);
              }
              errors++;
            }
          }
        }
        if (data59.quorum !== undefined) {
          let data61 = data59.quorum;
          if (!(typeof data61 == "number" && !(data61 % 1) && !isNaN(data61))) {
            const err117 = {
              instancePath: instancePath + "/verify/quorum",
              schemaPath: "#/properties/verify/properties/quorum/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err117];
            } else {
              vErrors.push(err117);
            }
            errors++;
          }
          if (typeof data61 == "number") {
            if (data61 < 1 || isNaN(data61)) {
              const err118 = {
                instancePath: instancePath + "/verify/quorum",
                schemaPath: "#/properties/verify/properties/quorum/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err118];
              } else {
                vErrors.push(err118);
              }
              errors++;
            }
          }
        }
        if (data59.model !== undefined) {
          let data62 = data59.model;
          if (typeof data62 === "string") {
            if (func2(data62) < 1) {
              const err119 = {
                instancePath: instancePath + "/verify/model",
                schemaPath: "#/properties/verify/properties/model/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err119];
              } else {
                vErrors.push(err119);
              }
              errors++;
            }
          } else {
            const err120 = {
              instancePath: instancePath + "/verify/model",
              schemaPath: "#/properties/verify/properties/model/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err120];
            } else {
              vErrors.push(err120);
            }
            errors++;
          }
        }
      } else {
        const err121 = {
          instancePath: instancePath + "/verify",
          schemaPath: "#/properties/verify/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err121];
        } else {
          vErrors.push(err121);
        }
        errors++;
      }
    }
  } else {
    const err122 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err122];
    } else {
      vErrors.push(err122);
    }
    errors++;
  }
  validate20.errors = vErrors;
  return errors === 0;
}
validate20.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const report = validate21;
const schema32 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://rio.dev/schemas/report-v1.json",
  title: "Rio report v1",
  type: "object",
  properties: {
    schema: { const: "rio-report-v1" },
    status: {
      enum: ["complete", "incomplete", "partial", "no_changes", "error"],
    },
    review: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        run_id: { type: "string", minLength: 1 },
        mode: { enum: ["working-tree", "staged", "branch"] },
        base: { type: "string", minLength: 1 },
        head: { type: "string", minLength: 1 },
        profile: { type: "string", minLength: 1 },
        chain: { type: "array", items: { type: "string", minLength: 1 } },
        rio_version: { type: "string", minLength: 1 },
      },
      required: ["rio_version"],
      additionalProperties: false,
    },
    checks: { type: "array", items: { $ref: "#/$defs/check" } },
    impact: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1 },
              symbol_path: { type: "string" },
              references_per_hop: {
                type: "array",
                items: { type: "integer", minimum: 0 },
              },
              test_referenced: { type: "boolean" },
              unresolved: { type: "integer", minimum: 0 },
            },
            required: [
              "path",
              "symbol_path",
              "references_per_hop",
              "test_referenced",
              "unresolved",
            ],
            additionalProperties: false,
          },
        },
        unresolved: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" },
      },
      required: ["symbols", "unresolved", "truncated"],
      additionalProperties: false,
    },
    findings: { type: "array", items: { $ref: "#/$defs/finding" } },
    risks: { type: "array", items: { $ref: "#/$defs/finding" } },
    incomplete: { type: "array", items: { $ref: "#/$defs/check" } },
    deferred: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "string", minLength: 1 },
          reason: { const: "no_endpoint" },
        },
        required: ["step", "reason"],
        additionalProperties: false,
      },
    },
    excluded: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
        },
        required: ["path", "reason"],
        additionalProperties: false,
      },
    },
    summary: {
      type: "object",
      properties: {
        pre_existing: { type: "integer", minimum: 0 },
        fixed: { type: "integer", minimum: 0 },
        suppressed: { type: "integer", minimum: 0 },
      },
      required: ["pre_existing", "fixed", "suppressed"],
      additionalProperties: false,
    },
    footer: {
      type: "object",
      properties: {
        notes: { type: "array", items: { type: "string", minLength: 1 } },
        suppressions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entry: { type: "integer", minimum: 0 },
              count: { type: "integer", minimum: 0 },
            },
            required: ["entry", "count"],
            additionalProperties: false,
          },
        },
        tool_versions: {
          type: "object",
          additionalProperties: { type: "string", minLength: 1 },
        },
      },
      required: ["notes", "suppressions", "tool_versions"],
      additionalProperties: false,
    },
    metrics: {
      type: "object",
      properties: {
        wall_time_ms: { type: "integer", minimum: 0 },
        checks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                enum: [
                  "typecheck",
                  "lint",
                  "secrets",
                  "coverage",
                  "dependencies",
                ],
              },
              root: { type: "string", minLength: 1 },
              version: { enum: ["base", "head"] },
              wall_time_ms: { type: "integer", minimum: 0 },
            },
            required: ["kind", "root", "version", "wall_time_ms"],
            additionalProperties: false,
          },
        },
        tool_versions: {
          type: "object",
          additionalProperties: { type: "string", minLength: 1 },
        },
      },
      required: ["wall_time_ms", "checks", "tool_versions"],
      additionalProperties: false,
    },
    error: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        details: { type: "array", items: { type: "string" } },
      },
      required: ["code", "message", "details"],
      additionalProperties: false,
    },
    risk_tier: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            tier: { enum: ["low", "medium", "high"] },
            reasons: { type: "array", items: { type: "string" } },
            source: { enum: ["always_human", "triage"] },
          },
          required: ["tier", "reasons", "source"],
          additionalProperties: false,
        },
      ],
    },
    security: { type: "array", items: { $ref: "#/$defs/finding" } },
    agent_audit: { type: "object", additionalProperties: true },
    lineage: {
      description:
        "Present only for reviews that belong to a review lineage (PR or --since-last branch).",
      type: "object",
      properties: {
        repository: { type: "string", minLength: 1 },
        kind: { enum: ["pr", "branch"] },
        ref: { type: "string", minLength: 1 },
        generation: { type: "integer", minimum: 1 },
        round: { type: "integer", minimum: 1 },
        cap: { type: "integer", minimum: 1 },
        capped: { type: "boolean" },
        diff_only: { type: "boolean" },
        previous_head: { type: ["string", "null"] },
        held_back: { type: "integer", minimum: 0 },
        rounds_to_pass: { type: ["integer", "null"], minimum: 1 },
        author_response_ratio: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 1,
        },
        reconsider: {
          type: "object",
          properties: {
            unresolved: { type: "integer", minimum: 0 },
            top: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  path: { type: "string" },
                  line_start: { type: "integer", minimum: 1 },
                },
                required: ["id", "title", "path", "line_start"],
                additionalProperties: false,
              },
            },
            split: { type: "array", items: { type: "string", minLength: 1 } },
          },
          required: ["unresolved", "top"],
          additionalProperties: false,
        },
      },
      required: [
        "repository",
        "kind",
        "ref",
        "generation",
        "round",
        "cap",
        "capped",
        "diff_only",
        "previous_head",
        "held_back",
        "rounds_to_pass",
        "author_response_ratio",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "schema",
    "status",
    "review",
    "checks",
    "impact",
    "findings",
    "risks",
    "incomplete",
    "deferred",
    "excluded",
    "metrics",
    "summary",
    "footer",
  ],
  additionalProperties: false,
  $defs: {
    finding: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^[a-f0-9]{64}$" },
        rule_id: { type: "string", minLength: 1 },
        category: { enum: ["defect", "risk", "security"] },
        evidence_level: {
          enum: ["reproduced", "static_proven", "plausible", "refuted"],
        },
        severity: { enum: ["error", "warning", "info"] },
        state: {
          enum: ["new", "worsened", "pre-existing", "fixed", "unclassified"],
        },
        location: {
          type: "object",
          properties: {
            path: {
              type: "string",
              minLength: 1,
              pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
            },
            line_start: { type: "integer", minimum: 1 },
            line_end: { type: "integer", minimum: 1 },
            column: { type: "integer", minimum: 1 },
            symbol_path: { type: "string" },
            occurrence_state: {
              enum: ["new", "pre-existing", "fixed", "unclassified"],
            },
          },
          required: [
            "path",
            "line_start",
            "line_end",
            "symbol_path",
            "occurrence_state",
          ],
          additionalProperties: false,
        },
        message: { type: "string", minLength: 1 },
        trigger: { type: "string" },
        impact: { type: "string", minLength: 1 },
        suggested_fix: { type: "string", minLength: 1 },
        evidence: { type: "array", items: { type: "string", minLength: 1 } },
        source: {
          oneOf: [
            {
              type: "object",
              properties: {
                tool: { type: "string", minLength: 1 },
                version: { type: "string", minLength: 1 },
              },
              required: ["tool", "version"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { agent: { type: "string", minLength: 1 } },
              required: ["agent"],
              additionalProperties: false,
            },
          ],
        },
        locations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                minLength: 1,
                pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
              },
              line_start: { type: "integer", minimum: 1 },
              line_end: { type: "integer", minimum: 1 },
              column: { type: "integer", minimum: 1 },
              symbol_path: { type: "string" },
              occurrence_state: {
                enum: ["new", "pre-existing", "fixed", "unclassified"],
              },
              id: {
                description:
                  "Identity of the instance finding when this location belongs to a class-level finding.",
                type: "string",
                minLength: 1,
              },
            },
            required: [
              "path",
              "line_start",
              "line_end",
              "symbol_path",
              "occurrence_state",
            ],
            additionalProperties: false,
          },
          minItems: 1,
        },
        advisory: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            aliases: { type: "array", items: { type: "string", minLength: 1 } },
            severity: {
              enum: ["critical", "high", "moderate", "low", "unknown"],
            },
            fixed_version: { type: "string", minLength: 1 },
            url: { type: "string", pattern: "^https://" },
          },
          required: ["id", "aliases", "severity", "fixed_version", "url"],
          additionalProperties: false,
        },
        round: { type: "integer", minimum: 1 },
        first_posted_in: { type: "string", minLength: 1 },
        author_response: {
          type: "object",
          properties: {
            reason: {
              enum: ["fixed", "wrong", "intentional", "irrelevant", "style"],
            },
            actor: { type: "string", minLength: 1 },
            at: { type: "string", format: "date-time" },
            note: { type: "string" },
          },
          required: ["reason", "actor", "at"],
          additionalProperties: false,
        },
        status: {
          description:
            "Lifecycle of a posted lineage finding, independent of regression state.",
          enum: ["open", "fixed", "dismissed"],
        },
        resolution: {
          description:
            "How the lifecycle status was reached: the head that fixed the finding, or why it stayed open.",
          type: "object",
          properties: {
            fixed_in: { type: "string", minLength: 1 },
            note: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        verification: {
          type: "object",
          properties: {
            voters: { type: "integer", minimum: 1 },
            agreeing: { type: "integer", minimum: 0 },
            blind_match: {
              type: "array",
              items: { enum: ["same", "related", "none"] },
            },
            split: { type: "boolean" },
          },
          required: ["voters", "agreeing", "blind_match", "split"],
          additionalProperties: false,
          description:
            "Semantic invariant: agreeing <= voters and blind_match contains one entry per configured voter; enforced by Rio deserialization and runtime validation.",
        },
      },
      required: [
        "id",
        "rule_id",
        "category",
        "evidence_level",
        "severity",
        "state",
        "location",
        "message",
        "trigger",
        "evidence",
        "source",
        "locations",
      ],
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { rule_id: { pattern: "^dependency/" } } },
          then: { required: ["advisory"] },
        },
      ],
    },
    check: {
      type: "object",
      properties: {
        kind: {
          enum: ["typecheck", "lint", "secrets", "coverage", "dependencies"],
        },
        language: { type: "string", minLength: 1 },
        root: { type: "string", minLength: 1 },
        version: { enum: ["base", "head"] },
        scheduled_as: { enum: ["changed", "dependent"] },
        outcome: {
          enum: ["passed", "findings", "failed", "skipped", "cancelled"],
        },
        reason: { type: "string" },
        hint: { type: "string" },
        dependency_state: { enum: ["verified", "trusted"] },
        wall_time_ms: { type: "integer", minimum: 0 },
        findings: { type: "array", items: { $ref: "#/$defs/finding" } },
        cached: { type: "boolean" },
      },
      required: [
        "kind",
        "language",
        "root",
        "version",
        "scheduled_as",
        "outcome",
        "wall_time_ms",
        "findings",
      ],
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { outcome: { const: "failed" } } },
          then: {
            required: ["reason"],
            properties: {
              reason: {
                enum: [
                  "spawn_failed",
                  "tool_crashed",
                  "tool_config_error",
                  "unparseable_output",
                  "output_limit",
                  "disk_full",
                  "tests_failed",
                  "network_error",
                  "partial_data",
                ],
              },
            },
          },
        },
        {
          if: { properties: { outcome: { const: "skipped" } } },
          then: {
            required: ["reason"],
            properties: {
              reason: {
                enum: [
                  "tool_missing",
                  "no_project_config",
                  "not_supported_by_adapter",
                  "disabled",
                  "offline",
                  "dependency_mismatch",
                  "no_tests",
                  "nothing_to_audit",
                ],
              },
            },
          },
        },
        {
          if: { properties: { outcome: { const: "cancelled" } } },
          then: {
            required: ["reason"],
            properties: { reason: { enum: ["timeout", "interrupted"] } },
          },
        },
        {
          if: { properties: { outcome: { enum: ["passed", "findings"] } } },
          then: { not: { required: ["reason"] } },
        },
      ],
    },
  },
  allOf: [
    {
      if: { properties: { status: { const: "error" } } },
      then: { required: ["error"] },
      else: { not: { required: ["error"] } },
    },
  ],
};
const schema34 = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-f0-9]{64}$" },
    rule_id: { type: "string", minLength: 1 },
    category: { enum: ["defect", "risk", "security"] },
    evidence_level: {
      enum: ["reproduced", "static_proven", "plausible", "refuted"],
    },
    severity: { enum: ["error", "warning", "info"] },
    state: {
      enum: ["new", "worsened", "pre-existing", "fixed", "unclassified"],
    },
    location: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
        },
        line_start: { type: "integer", minimum: 1 },
        line_end: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        symbol_path: { type: "string" },
        occurrence_state: {
          enum: ["new", "pre-existing", "fixed", "unclassified"],
        },
      },
      required: [
        "path",
        "line_start",
        "line_end",
        "symbol_path",
        "occurrence_state",
      ],
      additionalProperties: false,
    },
    message: { type: "string", minLength: 1 },
    trigger: { type: "string" },
    impact: { type: "string", minLength: 1 },
    suggested_fix: { type: "string", minLength: 1 },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
    source: {
      oneOf: [
        {
          type: "object",
          properties: {
            tool: { type: "string", minLength: 1 },
            version: { type: "string", minLength: 1 },
          },
          required: ["tool", "version"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { agent: { type: "string", minLength: 1 } },
          required: ["agent"],
          additionalProperties: false,
        },
      ],
    },
    locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
          },
          line_start: { type: "integer", minimum: 1 },
          line_end: { type: "integer", minimum: 1 },
          column: { type: "integer", minimum: 1 },
          symbol_path: { type: "string" },
          occurrence_state: {
            enum: ["new", "pre-existing", "fixed", "unclassified"],
          },
          id: {
            description:
              "Identity of the instance finding when this location belongs to a class-level finding.",
            type: "string",
            minLength: 1,
          },
        },
        required: [
          "path",
          "line_start",
          "line_end",
          "symbol_path",
          "occurrence_state",
        ],
        additionalProperties: false,
      },
      minItems: 1,
    },
    advisory: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        aliases: { type: "array", items: { type: "string", minLength: 1 } },
        severity: { enum: ["critical", "high", "moderate", "low", "unknown"] },
        fixed_version: { type: "string", minLength: 1 },
        url: { type: "string", pattern: "^https://" },
      },
      required: ["id", "aliases", "severity", "fixed_version", "url"],
      additionalProperties: false,
    },
    round: { type: "integer", minimum: 1 },
    first_posted_in: { type: "string", minLength: 1 },
    author_response: {
      type: "object",
      properties: {
        reason: {
          enum: ["fixed", "wrong", "intentional", "irrelevant", "style"],
        },
        actor: { type: "string", minLength: 1 },
        at: { type: "string", format: "date-time" },
        note: { type: "string" },
      },
      required: ["reason", "actor", "at"],
      additionalProperties: false,
    },
    status: {
      description:
        "Lifecycle of a posted lineage finding, independent of regression state.",
      enum: ["open", "fixed", "dismissed"],
    },
    resolution: {
      description:
        "How the lifecycle status was reached: the head that fixed the finding, or why it stayed open.",
      type: "object",
      properties: {
        fixed_in: { type: "string", minLength: 1 },
        note: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    verification: {
      type: "object",
      properties: {
        voters: { type: "integer", minimum: 1 },
        agreeing: { type: "integer", minimum: 0 },
        blind_match: {
          type: "array",
          items: { enum: ["same", "related", "none"] },
        },
        split: { type: "boolean" },
      },
      required: ["voters", "agreeing", "blind_match", "split"],
      additionalProperties: false,
      description:
        "Semantic invariant: agreeing <= voters and blind_match contains one entry per configured voter; enforced by Rio deserialization and runtime validation.",
    },
  },
  required: [
    "id",
    "rule_id",
    "category",
    "evidence_level",
    "severity",
    "state",
    "location",
    "message",
    "trigger",
    "evidence",
    "source",
    "locations",
  ],
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { rule_id: { pattern: "^dependency/" } } },
      then: { required: ["advisory"] },
    },
  ],
};
const schema33 = {
  type: "object",
  properties: {
    kind: {
      enum: ["typecheck", "lint", "secrets", "coverage", "dependencies"],
    },
    language: { type: "string", minLength: 1 },
    root: { type: "string", minLength: 1 },
    version: { enum: ["base", "head"] },
    scheduled_as: { enum: ["changed", "dependent"] },
    outcome: { enum: ["passed", "findings", "failed", "skipped", "cancelled"] },
    reason: { type: "string" },
    hint: { type: "string" },
    dependency_state: { enum: ["verified", "trusted"] },
    wall_time_ms: { type: "integer", minimum: 0 },
    findings: { type: "array", items: { $ref: "#/$defs/finding" } },
    cached: { type: "boolean" },
  },
  required: [
    "kind",
    "language",
    "root",
    "version",
    "scheduled_as",
    "outcome",
    "wall_time_ms",
    "findings",
  ],
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { outcome: { const: "failed" } } },
      then: {
        required: ["reason"],
        properties: {
          reason: {
            enum: [
              "spawn_failed",
              "tool_crashed",
              "tool_config_error",
              "unparseable_output",
              "output_limit",
              "disk_full",
              "tests_failed",
              "network_error",
              "partial_data",
            ],
          },
        },
      },
    },
    {
      if: { properties: { outcome: { const: "skipped" } } },
      then: {
        required: ["reason"],
        properties: {
          reason: {
            enum: [
              "tool_missing",
              "no_project_config",
              "not_supported_by_adapter",
              "disabled",
              "offline",
              "dependency_mismatch",
              "no_tests",
              "nothing_to_audit",
            ],
          },
        },
      },
    },
    {
      if: { properties: { outcome: { const: "cancelled" } } },
      then: {
        required: ["reason"],
        properties: { reason: { enum: ["timeout", "interrupted"] } },
      },
    },
    {
      if: { properties: { outcome: { enum: ["passed", "findings"] } } },
      then: { not: { required: ["reason"] } },
    },
  ],
};
const pattern6 = new RegExp("^dependency/", "u");
const pattern7 = new RegExp("^[a-f0-9]{64}$", "u");
const pattern8 = new RegExp(
  "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
  "u",
);
const pattern10 = new RegExp("^https://", "u");
const formats0 = require("ajv-formats/dist/formats").fullFormats["date-time"];
function validate22(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate22.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  const _errs2 = errors;
  let valid1 = true;
  const _errs3 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.outcome !== undefined) {
      if ("failed" !== data.outcome) {
        const err0 = {};
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
  }
  var _valid0 = _errs3 === errors;
  errors = _errs2;
  if (vErrors !== null) {
    if (_errs2) {
      vErrors.length = _errs2;
    } else {
      vErrors = null;
    }
  }
  if (_valid0) {
    const _errs5 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.reason === undefined) {
        const err1 = {
          instancePath,
          schemaPath: "#/allOf/0/then/required",
          keyword: "required",
          params: { missingProperty: "reason" },
          message: "must have required property '" + "reason" + "'",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (data.reason !== undefined) {
        let data1 = data.reason;
        if (!(
          data1 === "spawn_failed" ||
          data1 === "tool_crashed" ||
          data1 === "tool_config_error" ||
          data1 === "unparseable_output" ||
          data1 === "output_limit" ||
          data1 === "disk_full" ||
          data1 === "tests_failed" ||
          data1 === "network_error" ||
          data1 === "partial_data"
        )) {
          const err2 = {
            instancePath: instancePath + "/reason",
            schemaPath: "#/allOf/0/then/properties/reason/enum",
            keyword: "enum",
            params: {
              allowedValues: schema33.allOf[0].then.properties.reason.enum,
            },
            message: "must be equal to one of the allowed values",
          };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
      }
    }
    var _valid0 = _errs5 === errors;
    valid1 = _valid0;
    if (valid1) {
      var props0 = {};
      props0.reason = true;
      props0.outcome = true;
    }
  }
  if (!valid1) {
    const err3 = {
      instancePath,
      schemaPath: "#/allOf/0/if",
      keyword: "if",
      params: { failingKeyword: "then" },
      message: 'must match "then" schema',
    };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  const _errs8 = errors;
  let valid4 = true;
  const _errs9 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.outcome !== undefined) {
      if ("skipped" !== data.outcome) {
        const err4 = {};
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
  }
  var _valid1 = _errs9 === errors;
  errors = _errs8;
  if (vErrors !== null) {
    if (_errs8) {
      vErrors.length = _errs8;
    } else {
      vErrors = null;
    }
  }
  if (_valid1) {
    const _errs11 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.reason === undefined) {
        const err5 = {
          instancePath,
          schemaPath: "#/allOf/1/then/required",
          keyword: "required",
          params: { missingProperty: "reason" },
          message: "must have required property '" + "reason" + "'",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
      if (data.reason !== undefined) {
        let data3 = data.reason;
        if (!(
          data3 === "tool_missing" ||
          data3 === "no_project_config" ||
          data3 === "not_supported_by_adapter" ||
          data3 === "disabled" ||
          data3 === "offline" ||
          data3 === "dependency_mismatch" ||
          data3 === "no_tests" ||
          data3 === "nothing_to_audit"
        )) {
          const err6 = {
            instancePath: instancePath + "/reason",
            schemaPath: "#/allOf/1/then/properties/reason/enum",
            keyword: "enum",
            params: {
              allowedValues: schema33.allOf[1].then.properties.reason.enum,
            },
            message: "must be equal to one of the allowed values",
          };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
      }
    }
    var _valid1 = _errs11 === errors;
    valid4 = _valid1;
    if (valid4) {
      var props1 = {};
      props1.reason = true;
      props1.outcome = true;
    }
  }
  if (!valid4) {
    const err7 = {
      instancePath,
      schemaPath: "#/allOf/1/if",
      keyword: "if",
      params: { failingKeyword: "then" },
      message: 'must match "then" schema',
    };
    if (vErrors === null) {
      vErrors = [err7];
    } else {
      vErrors.push(err7);
    }
    errors++;
  }
  if (props0 !== true && props1 !== undefined) {
    if (props1 === true) {
      props0 = true;
    } else {
      props0 = props0 || {};
      Object.assign(props0, props1);
    }
  }
  const _errs14 = errors;
  let valid7 = true;
  const _errs15 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.outcome !== undefined) {
      if ("cancelled" !== data.outcome) {
        const err8 = {};
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
  }
  var _valid2 = _errs15 === errors;
  errors = _errs14;
  if (vErrors !== null) {
    if (_errs14) {
      vErrors.length = _errs14;
    } else {
      vErrors = null;
    }
  }
  if (_valid2) {
    const _errs17 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.reason === undefined) {
        const err9 = {
          instancePath,
          schemaPath: "#/allOf/2/then/required",
          keyword: "required",
          params: { missingProperty: "reason" },
          message: "must have required property '" + "reason" + "'",
        };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
      if (data.reason !== undefined) {
        let data5 = data.reason;
        if (!(data5 === "timeout" || data5 === "interrupted")) {
          const err10 = {
            instancePath: instancePath + "/reason",
            schemaPath: "#/allOf/2/then/properties/reason/enum",
            keyword: "enum",
            params: {
              allowedValues: schema33.allOf[2].then.properties.reason.enum,
            },
            message: "must be equal to one of the allowed values",
          };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      }
    }
    var _valid2 = _errs17 === errors;
    valid7 = _valid2;
    if (valid7) {
      var props2 = {};
      props2.reason = true;
      props2.outcome = true;
    }
  }
  if (!valid7) {
    const err11 = {
      instancePath,
      schemaPath: "#/allOf/2/if",
      keyword: "if",
      params: { failingKeyword: "then" },
      message: 'must match "then" schema',
    };
    if (vErrors === null) {
      vErrors = [err11];
    } else {
      vErrors.push(err11);
    }
    errors++;
  }
  if (props0 !== true && props2 !== undefined) {
    if (props2 === true) {
      props0 = true;
    } else {
      props0 = props0 || {};
      Object.assign(props0, props2);
    }
  }
  const _errs20 = errors;
  let valid10 = true;
  const _errs21 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.outcome !== undefined) {
      let data6 = data.outcome;
      if (!(data6 === "passed" || data6 === "findings")) {
        const err12 = {};
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
  }
  var _valid3 = _errs21 === errors;
  errors = _errs20;
  if (vErrors !== null) {
    if (_errs20) {
      vErrors.length = _errs20;
    } else {
      vErrors = null;
    }
  }
  if (_valid3) {
    const _errs23 = errors;
    const _errs24 = errors;
    const _errs25 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.reason === undefined && (missing0 = "reason")) {
        const err13 = {};
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    var valid12 = _errs25 === errors;
    if (valid12) {
      const err14 = {
        instancePath,
        schemaPath: "#/allOf/3/then/not",
        keyword: "not",
        params: {},
        message: "must NOT be valid",
      };
      if (vErrors === null) {
        vErrors = [err14];
      } else {
        vErrors.push(err14);
      }
      errors++;
    } else {
      errors = _errs24;
      if (vErrors !== null) {
        if (_errs24) {
          vErrors.length = _errs24;
        } else {
          vErrors = null;
        }
      }
    }
    var _valid3 = _errs23 === errors;
    valid10 = _valid3;
  }
  if (!valid10) {
    const err15 = {
      instancePath,
      schemaPath: "#/allOf/3/if",
      keyword: "if",
      params: { failingKeyword: "then" },
      message: 'must match "then" schema',
    };
    if (vErrors === null) {
      vErrors = [err15];
    } else {
      vErrors.push(err15);
    }
    errors++;
  }
  if (props0 !== true) {
    props0 = props0 || {};
    props0.outcome = true;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.kind === undefined) {
      const err16 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "kind" },
        message: "must have required property '" + "kind" + "'",
      };
      if (vErrors === null) {
        vErrors = [err16];
      } else {
        vErrors.push(err16);
      }
      errors++;
    }
    if (data.language === undefined) {
      const err17 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "language" },
        message: "must have required property '" + "language" + "'",
      };
      if (vErrors === null) {
        vErrors = [err17];
      } else {
        vErrors.push(err17);
      }
      errors++;
    }
    if (data.root === undefined) {
      const err18 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "root" },
        message: "must have required property '" + "root" + "'",
      };
      if (vErrors === null) {
        vErrors = [err18];
      } else {
        vErrors.push(err18);
      }
      errors++;
    }
    if (data.version === undefined) {
      const err19 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "version" },
        message: "must have required property '" + "version" + "'",
      };
      if (vErrors === null) {
        vErrors = [err19];
      } else {
        vErrors.push(err19);
      }
      errors++;
    }
    if (data.scheduled_as === undefined) {
      const err20 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "scheduled_as" },
        message: "must have required property '" + "scheduled_as" + "'",
      };
      if (vErrors === null) {
        vErrors = [err20];
      } else {
        vErrors.push(err20);
      }
      errors++;
    }
    if (data.outcome === undefined) {
      const err21 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "outcome" },
        message: "must have required property '" + "outcome" + "'",
      };
      if (vErrors === null) {
        vErrors = [err21];
      } else {
        vErrors.push(err21);
      }
      errors++;
    }
    if (data.wall_time_ms === undefined) {
      const err22 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "wall_time_ms" },
        message: "must have required property '" + "wall_time_ms" + "'",
      };
      if (vErrors === null) {
        vErrors = [err22];
      } else {
        vErrors.push(err22);
      }
      errors++;
    }
    if (data.findings === undefined) {
      const err23 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "findings" },
        message: "must have required property '" + "findings" + "'",
      };
      if (vErrors === null) {
        vErrors = [err23];
      } else {
        vErrors.push(err23);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema33.properties, key0)) {
        const err24 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err24];
        } else {
          vErrors.push(err24);
        }
        errors++;
      }
    }
    if (data.kind !== undefined) {
      let data7 = data.kind;
      if (!(
        data7 === "typecheck" ||
        data7 === "lint" ||
        data7 === "secrets" ||
        data7 === "coverage" ||
        data7 === "dependencies"
      )) {
        const err25 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/properties/kind/enum",
          keyword: "enum",
          params: { allowedValues: schema33.properties.kind.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err25];
        } else {
          vErrors.push(err25);
        }
        errors++;
      }
    }
    if (data.language !== undefined) {
      let data8 = data.language;
      if (typeof data8 === "string") {
        if (func2(data8) < 1) {
          const err26 = {
            instancePath: instancePath + "/language",
            schemaPath: "#/properties/language/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err26];
          } else {
            vErrors.push(err26);
          }
          errors++;
        }
      } else {
        const err27 = {
          instancePath: instancePath + "/language",
          schemaPath: "#/properties/language/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err27];
        } else {
          vErrors.push(err27);
        }
        errors++;
      }
    }
    if (data.root !== undefined) {
      let data9 = data.root;
      if (typeof data9 === "string") {
        if (func2(data9) < 1) {
          const err28 = {
            instancePath: instancePath + "/root",
            schemaPath: "#/properties/root/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err28];
          } else {
            vErrors.push(err28);
          }
          errors++;
        }
      } else {
        const err29 = {
          instancePath: instancePath + "/root",
          schemaPath: "#/properties/root/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err29];
        } else {
          vErrors.push(err29);
        }
        errors++;
      }
    }
    if (data.version !== undefined) {
      let data10 = data.version;
      if (!(data10 === "base" || data10 === "head")) {
        const err30 = {
          instancePath: instancePath + "/version",
          schemaPath: "#/properties/version/enum",
          keyword: "enum",
          params: { allowedValues: schema33.properties.version.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err30];
        } else {
          vErrors.push(err30);
        }
        errors++;
      }
    }
    if (data.scheduled_as !== undefined) {
      let data11 = data.scheduled_as;
      if (!(data11 === "changed" || data11 === "dependent")) {
        const err31 = {
          instancePath: instancePath + "/scheduled_as",
          schemaPath: "#/properties/scheduled_as/enum",
          keyword: "enum",
          params: { allowedValues: schema33.properties.scheduled_as.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err31];
        } else {
          vErrors.push(err31);
        }
        errors++;
      }
    }
    if (data.outcome !== undefined) {
      let data12 = data.outcome;
      if (!(
        data12 === "passed" ||
        data12 === "findings" ||
        data12 === "failed" ||
        data12 === "skipped" ||
        data12 === "cancelled"
      )) {
        const err32 = {
          instancePath: instancePath + "/outcome",
          schemaPath: "#/properties/outcome/enum",
          keyword: "enum",
          params: { allowedValues: schema33.properties.outcome.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err32];
        } else {
          vErrors.push(err32);
        }
        errors++;
      }
    }
    if (data.reason !== undefined) {
      if (typeof data.reason !== "string") {
        const err33 = {
          instancePath: instancePath + "/reason",
          schemaPath: "#/properties/reason/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err33];
        } else {
          vErrors.push(err33);
        }
        errors++;
      }
    }
    if (data.hint !== undefined) {
      if (typeof data.hint !== "string") {
        const err34 = {
          instancePath: instancePath + "/hint",
          schemaPath: "#/properties/hint/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err34];
        } else {
          vErrors.push(err34);
        }
        errors++;
      }
    }
    if (data.dependency_state !== undefined) {
      let data15 = data.dependency_state;
      if (!(data15 === "verified" || data15 === "trusted")) {
        const err35 = {
          instancePath: instancePath + "/dependency_state",
          schemaPath: "#/properties/dependency_state/enum",
          keyword: "enum",
          params: { allowedValues: schema33.properties.dependency_state.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err35];
        } else {
          vErrors.push(err35);
        }
        errors++;
      }
    }
    if (data.wall_time_ms !== undefined) {
      let data16 = data.wall_time_ms;
      if (!(typeof data16 == "number" && !(data16 % 1) && !isNaN(data16))) {
        const err36 = {
          instancePath: instancePath + "/wall_time_ms",
          schemaPath: "#/properties/wall_time_ms/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err36];
        } else {
          vErrors.push(err36);
        }
        errors++;
      }
      if (typeof data16 == "number") {
        if (data16 < 0 || isNaN(data16)) {
          const err37 = {
            instancePath: instancePath + "/wall_time_ms",
            schemaPath: "#/properties/wall_time_ms/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err37];
          } else {
            vErrors.push(err37);
          }
          errors++;
        }
      }
    }
    if (data.findings !== undefined) {
      let data17 = data.findings;
      if (Array.isArray(data17)) {
        const len0 = data17.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data18 = data17[i0];
          const _errs48 = errors;
          let valid18 = true;
          const _errs49 = errors;
          if (data18 && typeof data18 == "object" && !Array.isArray(data18)) {
            if (data18.rule_id !== undefined) {
              let data19 = data18.rule_id;
              if (typeof data19 === "string") {
                if (!pattern6.test(data19)) {
                  const err38 = {};
                  if (vErrors === null) {
                    vErrors = [err38];
                  } else {
                    vErrors.push(err38);
                  }
                  errors++;
                }
              }
            }
          }
          var _valid4 = _errs49 === errors;
          errors = _errs48;
          if (vErrors !== null) {
            if (_errs48) {
              vErrors.length = _errs48;
            } else {
              vErrors = null;
            }
          }
          if (_valid4) {
            const _errs51 = errors;
            if (data18 && typeof data18 == "object" && !Array.isArray(data18)) {
              if (data18.advisory === undefined) {
                const err39 = {
                  instancePath: instancePath + "/findings/" + i0,
                  schemaPath: "#/$defs/finding/allOf/0/then/required",
                  keyword: "required",
                  params: { missingProperty: "advisory" },
                  message: "must have required property '" + "advisory" + "'",
                };
                if (vErrors === null) {
                  vErrors = [err39];
                } else {
                  vErrors.push(err39);
                }
                errors++;
              }
            }
            var _valid4 = _errs51 === errors;
            valid18 = _valid4;
          }
          if (!valid18) {
            const err40 = {
              instancePath: instancePath + "/findings/" + i0,
              schemaPath: "#/$defs/finding/allOf/0/if",
              keyword: "if",
              params: { failingKeyword: "then" },
              message: 'must match "then" schema',
            };
            if (vErrors === null) {
              vErrors = [err40];
            } else {
              vErrors.push(err40);
            }
            errors++;
          }
          if (data18 && typeof data18 == "object" && !Array.isArray(data18)) {
            if (data18.id === undefined) {
              const err41 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "id" },
                message: "must have required property '" + "id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err41];
              } else {
                vErrors.push(err41);
              }
              errors++;
            }
            if (data18.rule_id === undefined) {
              const err42 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "rule_id" },
                message: "must have required property '" + "rule_id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err42];
              } else {
                vErrors.push(err42);
              }
              errors++;
            }
            if (data18.category === undefined) {
              const err43 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "category" },
                message: "must have required property '" + "category" + "'",
              };
              if (vErrors === null) {
                vErrors = [err43];
              } else {
                vErrors.push(err43);
              }
              errors++;
            }
            if (data18.evidence_level === undefined) {
              const err44 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "evidence_level" },
                message:
                  "must have required property '" + "evidence_level" + "'",
              };
              if (vErrors === null) {
                vErrors = [err44];
              } else {
                vErrors.push(err44);
              }
              errors++;
            }
            if (data18.severity === undefined) {
              const err45 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "severity" },
                message: "must have required property '" + "severity" + "'",
              };
              if (vErrors === null) {
                vErrors = [err45];
              } else {
                vErrors.push(err45);
              }
              errors++;
            }
            if (data18.state === undefined) {
              const err46 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "state" },
                message: "must have required property '" + "state" + "'",
              };
              if (vErrors === null) {
                vErrors = [err46];
              } else {
                vErrors.push(err46);
              }
              errors++;
            }
            if (data18.location === undefined) {
              const err47 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "location" },
                message: "must have required property '" + "location" + "'",
              };
              if (vErrors === null) {
                vErrors = [err47];
              } else {
                vErrors.push(err47);
              }
              errors++;
            }
            if (data18.message === undefined) {
              const err48 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "message" },
                message: "must have required property '" + "message" + "'",
              };
              if (vErrors === null) {
                vErrors = [err48];
              } else {
                vErrors.push(err48);
              }
              errors++;
            }
            if (data18.trigger === undefined) {
              const err49 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "trigger" },
                message: "must have required property '" + "trigger" + "'",
              };
              if (vErrors === null) {
                vErrors = [err49];
              } else {
                vErrors.push(err49);
              }
              errors++;
            }
            if (data18.evidence === undefined) {
              const err50 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "evidence" },
                message: "must have required property '" + "evidence" + "'",
              };
              if (vErrors === null) {
                vErrors = [err50];
              } else {
                vErrors.push(err50);
              }
              errors++;
            }
            if (data18.source === undefined) {
              const err51 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "source" },
                message: "must have required property '" + "source" + "'",
              };
              if (vErrors === null) {
                vErrors = [err51];
              } else {
                vErrors.push(err51);
              }
              errors++;
            }
            if (data18.locations === undefined) {
              const err52 = {
                instancePath: instancePath + "/findings/" + i0,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "locations" },
                message: "must have required property '" + "locations" + "'",
              };
              if (vErrors === null) {
                vErrors = [err52];
              } else {
                vErrors.push(err52);
              }
              errors++;
            }
            for (const key1 in data18) {
              if (!func1.call(schema34.properties, key1)) {
                const err53 = {
                  instancePath: instancePath + "/findings/" + i0,
                  schemaPath: "#/$defs/finding/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key1 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err53];
                } else {
                  vErrors.push(err53);
                }
                errors++;
              }
            }
            if (data18.id !== undefined) {
              let data20 = data18.id;
              if (typeof data20 === "string") {
                if (!pattern7.test(data20)) {
                  const err54 = {
                    instancePath: instancePath + "/findings/" + i0 + "/id",
                    schemaPath: "#/$defs/finding/properties/id/pattern",
                    keyword: "pattern",
                    params: { pattern: "^[a-f0-9]{64}$" },
                    message: 'must match pattern "' + "^[a-f0-9]{64}$" + '"',
                  };
                  if (vErrors === null) {
                    vErrors = [err54];
                  } else {
                    vErrors.push(err54);
                  }
                  errors++;
                }
              } else {
                const err55 = {
                  instancePath: instancePath + "/findings/" + i0 + "/id",
                  schemaPath: "#/$defs/finding/properties/id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err55];
                } else {
                  vErrors.push(err55);
                }
                errors++;
              }
            }
            if (data18.rule_id !== undefined) {
              let data21 = data18.rule_id;
              if (typeof data21 === "string") {
                if (func2(data21) < 1) {
                  const err56 = {
                    instancePath: instancePath + "/findings/" + i0 + "/rule_id",
                    schemaPath: "#/$defs/finding/properties/rule_id/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err56];
                  } else {
                    vErrors.push(err56);
                  }
                  errors++;
                }
              } else {
                const err57 = {
                  instancePath: instancePath + "/findings/" + i0 + "/rule_id",
                  schemaPath: "#/$defs/finding/properties/rule_id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err57];
                } else {
                  vErrors.push(err57);
                }
                errors++;
              }
            }
            if (data18.category !== undefined) {
              let data22 = data18.category;
              if (!(
                data22 === "defect" ||
                data22 === "risk" ||
                data22 === "security"
              )) {
                const err58 = {
                  instancePath: instancePath + "/findings/" + i0 + "/category",
                  schemaPath: "#/$defs/finding/properties/category/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.category.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err58];
                } else {
                  vErrors.push(err58);
                }
                errors++;
              }
            }
            if (data18.evidence_level !== undefined) {
              let data23 = data18.evidence_level;
              if (!(
                data23 === "reproduced" ||
                data23 === "static_proven" ||
                data23 === "plausible" ||
                data23 === "refuted"
              )) {
                const err59 = {
                  instancePath:
                    instancePath + "/findings/" + i0 + "/evidence_level",
                  schemaPath: "#/$defs/finding/properties/evidence_level/enum",
                  keyword: "enum",
                  params: {
                    allowedValues: schema34.properties.evidence_level.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err59];
                } else {
                  vErrors.push(err59);
                }
                errors++;
              }
            }
            if (data18.severity !== undefined) {
              let data24 = data18.severity;
              if (!(
                data24 === "error" ||
                data24 === "warning" ||
                data24 === "info"
              )) {
                const err60 = {
                  instancePath: instancePath + "/findings/" + i0 + "/severity",
                  schemaPath: "#/$defs/finding/properties/severity/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.severity.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err60];
                } else {
                  vErrors.push(err60);
                }
                errors++;
              }
            }
            if (data18.state !== undefined) {
              let data25 = data18.state;
              if (!(
                data25 === "new" ||
                data25 === "worsened" ||
                data25 === "pre-existing" ||
                data25 === "fixed" ||
                data25 === "unclassified"
              )) {
                const err61 = {
                  instancePath: instancePath + "/findings/" + i0 + "/state",
                  schemaPath: "#/$defs/finding/properties/state/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.state.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err61];
                } else {
                  vErrors.push(err61);
                }
                errors++;
              }
            }
            if (data18.location !== undefined) {
              let data26 = data18.location;
              if (
                data26 &&
                typeof data26 == "object" &&
                !Array.isArray(data26)
              ) {
                if (data26.path === undefined) {
                  const err62 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "path" },
                    message: "must have required property '" + "path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err62];
                  } else {
                    vErrors.push(err62);
                  }
                  errors++;
                }
                if (data26.line_start === undefined) {
                  const err63 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "line_start" },
                    message:
                      "must have required property '" + "line_start" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err63];
                  } else {
                    vErrors.push(err63);
                  }
                  errors++;
                }
                if (data26.line_end === undefined) {
                  const err64 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "line_end" },
                    message: "must have required property '" + "line_end" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err64];
                  } else {
                    vErrors.push(err64);
                  }
                  errors++;
                }
                if (data26.symbol_path === undefined) {
                  const err65 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "symbol_path" },
                    message:
                      "must have required property '" + "symbol_path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err65];
                  } else {
                    vErrors.push(err65);
                  }
                  errors++;
                }
                if (data26.occurrence_state === undefined) {
                  const err66 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "occurrence_state" },
                    message:
                      "must have required property '" +
                      "occurrence_state" +
                      "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err66];
                  } else {
                    vErrors.push(err66);
                  }
                  errors++;
                }
                for (const key2 in data26) {
                  if (!(
                    key2 === "path" ||
                    key2 === "line_start" ||
                    key2 === "line_end" ||
                    key2 === "column" ||
                    key2 === "symbol_path" ||
                    key2 === "occurrence_state"
                  )) {
                    const err67 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/location",
                      schemaPath:
                        "#/$defs/finding/properties/location/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key2 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err67];
                    } else {
                      vErrors.push(err67);
                    }
                    errors++;
                  }
                }
                if (data26.path !== undefined) {
                  let data27 = data26.path;
                  if (typeof data27 === "string") {
                    if (func2(data27) < 1) {
                      const err68 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/location/path",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/path/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err68];
                      } else {
                        vErrors.push(err68);
                      }
                      errors++;
                    }
                    if (!pattern8.test(data27)) {
                      const err69 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/location/path",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/path/pattern",
                        keyword: "pattern",
                        params: {
                          pattern:
                            "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                        },
                        message:
                          'must match pattern "' +
                          "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                          '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err69];
                      } else {
                        vErrors.push(err69);
                      }
                      errors++;
                    }
                  } else {
                    const err70 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/location/path",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err70];
                    } else {
                      vErrors.push(err70);
                    }
                    errors++;
                  }
                }
                if (data26.line_start !== undefined) {
                  let data28 = data26.line_start;
                  if (!(
                    typeof data28 == "number" &&
                    !(data28 % 1) &&
                    !isNaN(data28)
                  )) {
                    const err71 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/location/line_start",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/line_start/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err71];
                    } else {
                      vErrors.push(err71);
                    }
                    errors++;
                  }
                  if (typeof data28 == "number") {
                    if (data28 < 1 || isNaN(data28)) {
                      const err72 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i0 +
                          "/location/line_start",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/line_start/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err72];
                      } else {
                        vErrors.push(err72);
                      }
                      errors++;
                    }
                  }
                }
                if (data26.line_end !== undefined) {
                  let data29 = data26.line_end;
                  if (!(
                    typeof data29 == "number" &&
                    !(data29 % 1) &&
                    !isNaN(data29)
                  )) {
                    const err73 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/location/line_end",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/line_end/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err73];
                    } else {
                      vErrors.push(err73);
                    }
                    errors++;
                  }
                  if (typeof data29 == "number") {
                    if (data29 < 1 || isNaN(data29)) {
                      const err74 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i0 +
                          "/location/line_end",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/line_end/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err74];
                      } else {
                        vErrors.push(err74);
                      }
                      errors++;
                    }
                  }
                }
                if (data26.column !== undefined) {
                  let data30 = data26.column;
                  if (!(
                    typeof data30 == "number" &&
                    !(data30 % 1) &&
                    !isNaN(data30)
                  )) {
                    const err75 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/location/column",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/column/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err75];
                    } else {
                      vErrors.push(err75);
                    }
                    errors++;
                  }
                  if (typeof data30 == "number") {
                    if (data30 < 1 || isNaN(data30)) {
                      const err76 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/location/column",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/column/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err76];
                      } else {
                        vErrors.push(err76);
                      }
                      errors++;
                    }
                  }
                }
                if (data26.symbol_path !== undefined) {
                  if (typeof data26.symbol_path !== "string") {
                    const err77 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/location/symbol_path",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/symbol_path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err77];
                    } else {
                      vErrors.push(err77);
                    }
                    errors++;
                  }
                }
                if (data26.occurrence_state !== undefined) {
                  let data32 = data26.occurrence_state;
                  if (!(
                    data32 === "new" ||
                    data32 === "pre-existing" ||
                    data32 === "fixed" ||
                    data32 === "unclassified"
                  )) {
                    const err78 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/location/occurrence_state",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/occurrence_state/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.location.properties
                            .occurrence_state.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err78];
                    } else {
                      vErrors.push(err78);
                    }
                    errors++;
                  }
                }
              } else {
                const err79 = {
                  instancePath: instancePath + "/findings/" + i0 + "/location",
                  schemaPath: "#/$defs/finding/properties/location/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err79];
                } else {
                  vErrors.push(err79);
                }
                errors++;
              }
            }
            if (data18.message !== undefined) {
              let data33 = data18.message;
              if (typeof data33 === "string") {
                if (func2(data33) < 1) {
                  const err80 = {
                    instancePath: instancePath + "/findings/" + i0 + "/message",
                    schemaPath: "#/$defs/finding/properties/message/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err80];
                  } else {
                    vErrors.push(err80);
                  }
                  errors++;
                }
              } else {
                const err81 = {
                  instancePath: instancePath + "/findings/" + i0 + "/message",
                  schemaPath: "#/$defs/finding/properties/message/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err81];
                } else {
                  vErrors.push(err81);
                }
                errors++;
              }
            }
            if (data18.trigger !== undefined) {
              if (typeof data18.trigger !== "string") {
                const err82 = {
                  instancePath: instancePath + "/findings/" + i0 + "/trigger",
                  schemaPath: "#/$defs/finding/properties/trigger/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err82];
                } else {
                  vErrors.push(err82);
                }
                errors++;
              }
            }
            if (data18.impact !== undefined) {
              let data35 = data18.impact;
              if (typeof data35 === "string") {
                if (func2(data35) < 1) {
                  const err83 = {
                    instancePath: instancePath + "/findings/" + i0 + "/impact",
                    schemaPath: "#/$defs/finding/properties/impact/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err83];
                  } else {
                    vErrors.push(err83);
                  }
                  errors++;
                }
              } else {
                const err84 = {
                  instancePath: instancePath + "/findings/" + i0 + "/impact",
                  schemaPath: "#/$defs/finding/properties/impact/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err84];
                } else {
                  vErrors.push(err84);
                }
                errors++;
              }
            }
            if (data18.suggested_fix !== undefined) {
              let data36 = data18.suggested_fix;
              if (typeof data36 === "string") {
                if (func2(data36) < 1) {
                  const err85 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/suggested_fix",
                    schemaPath:
                      "#/$defs/finding/properties/suggested_fix/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err85];
                  } else {
                    vErrors.push(err85);
                  }
                  errors++;
                }
              } else {
                const err86 = {
                  instancePath:
                    instancePath + "/findings/" + i0 + "/suggested_fix",
                  schemaPath: "#/$defs/finding/properties/suggested_fix/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err86];
                } else {
                  vErrors.push(err86);
                }
                errors++;
              }
            }
            if (data18.evidence !== undefined) {
              let data37 = data18.evidence;
              if (Array.isArray(data37)) {
                const len1 = data37.length;
                for (let i1 = 0; i1 < len1; i1++) {
                  let data38 = data37[i1];
                  if (typeof data38 === "string") {
                    if (func2(data38) < 1) {
                      const err87 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/evidence/" + i1,
                        schemaPath:
                          "#/$defs/finding/properties/evidence/items/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err87];
                      } else {
                        vErrors.push(err87);
                      }
                      errors++;
                    }
                  } else {
                    const err88 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/evidence/" + i1,
                      schemaPath:
                        "#/$defs/finding/properties/evidence/items/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err88];
                    } else {
                      vErrors.push(err88);
                    }
                    errors++;
                  }
                }
              } else {
                const err89 = {
                  instancePath: instancePath + "/findings/" + i0 + "/evidence",
                  schemaPath: "#/$defs/finding/properties/evidence/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err89];
                } else {
                  vErrors.push(err89);
                }
                errors++;
              }
            }
            if (data18.source !== undefined) {
              let data39 = data18.source;
              const _errs88 = errors;
              let valid24 = false;
              let passing0 = null;
              const _errs89 = errors;
              if (
                data39 &&
                typeof data39 == "object" &&
                !Array.isArray(data39)
              ) {
                if (data39.tool === undefined) {
                  const err90 = {
                    instancePath: instancePath + "/findings/" + i0 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/0/required",
                    keyword: "required",
                    params: { missingProperty: "tool" },
                    message: "must have required property '" + "tool" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err90];
                  } else {
                    vErrors.push(err90);
                  }
                  errors++;
                }
                if (data39.version === undefined) {
                  const err91 = {
                    instancePath: instancePath + "/findings/" + i0 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/0/required",
                    keyword: "required",
                    params: { missingProperty: "version" },
                    message: "must have required property '" + "version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err91];
                  } else {
                    vErrors.push(err91);
                  }
                  errors++;
                }
                for (const key3 in data39) {
                  if (!(key3 === "tool" || key3 === "version")) {
                    const err92 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/source",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key3 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err92];
                    } else {
                      vErrors.push(err92);
                    }
                    errors++;
                  }
                }
                if (data39.tool !== undefined) {
                  let data40 = data39.tool;
                  if (typeof data40 === "string") {
                    if (func2(data40) < 1) {
                      const err93 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/source/tool",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/0/properties/tool/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err93];
                      } else {
                        vErrors.push(err93);
                      }
                      errors++;
                    }
                  } else {
                    const err94 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/source/tool",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/properties/tool/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err94];
                    } else {
                      vErrors.push(err94);
                    }
                    errors++;
                  }
                }
                if (data39.version !== undefined) {
                  let data41 = data39.version;
                  if (typeof data41 === "string") {
                    if (func2(data41) < 1) {
                      const err95 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/source/version",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/0/properties/version/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err95];
                      } else {
                        vErrors.push(err95);
                      }
                      errors++;
                    }
                  } else {
                    const err96 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/source/version",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/properties/version/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err96];
                    } else {
                      vErrors.push(err96);
                    }
                    errors++;
                  }
                }
              } else {
                const err97 = {
                  instancePath: instancePath + "/findings/" + i0 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf/0/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err97];
                } else {
                  vErrors.push(err97);
                }
                errors++;
              }
              var _valid5 = _errs89 === errors;
              if (_valid5) {
                valid24 = true;
                passing0 = 0;
                var props3 = true;
              }
              const _errs96 = errors;
              if (
                data39 &&
                typeof data39 == "object" &&
                !Array.isArray(data39)
              ) {
                if (data39.agent === undefined) {
                  const err98 = {
                    instancePath: instancePath + "/findings/" + i0 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/1/required",
                    keyword: "required",
                    params: { missingProperty: "agent" },
                    message: "must have required property '" + "agent" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err98];
                  } else {
                    vErrors.push(err98);
                  }
                  errors++;
                }
                for (const key4 in data39) {
                  if (!(key4 === "agent")) {
                    const err99 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/source",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/1/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key4 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err99];
                    } else {
                      vErrors.push(err99);
                    }
                    errors++;
                  }
                }
                if (data39.agent !== undefined) {
                  let data42 = data39.agent;
                  if (typeof data42 === "string") {
                    if (func2(data42) < 1) {
                      const err100 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/source/agent",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/1/properties/agent/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err100];
                      } else {
                        vErrors.push(err100);
                      }
                      errors++;
                    }
                  } else {
                    const err101 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/source/agent",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/1/properties/agent/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err101];
                    } else {
                      vErrors.push(err101);
                    }
                    errors++;
                  }
                }
              } else {
                const err102 = {
                  instancePath: instancePath + "/findings/" + i0 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf/1/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err102];
                } else {
                  vErrors.push(err102);
                }
                errors++;
              }
              var _valid5 = _errs96 === errors;
              if (_valid5 && valid24) {
                valid24 = false;
                passing0 = [passing0, 1];
              } else {
                if (_valid5) {
                  valid24 = true;
                  passing0 = 1;
                  if (props3 !== true) {
                    props3 = true;
                  }
                }
              }
              if (!valid24) {
                const err103 = {
                  instancePath: instancePath + "/findings/" + i0 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf",
                  keyword: "oneOf",
                  params: { passingSchemas: passing0 },
                  message: "must match exactly one schema in oneOf",
                };
                if (vErrors === null) {
                  vErrors = [err103];
                } else {
                  vErrors.push(err103);
                }
                errors++;
              } else {
                errors = _errs88;
                if (vErrors !== null) {
                  if (_errs88) {
                    vErrors.length = _errs88;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
            if (data18.locations !== undefined) {
              let data43 = data18.locations;
              if (Array.isArray(data43)) {
                if (data43.length < 1) {
                  const err104 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/locations",
                    schemaPath: "#/$defs/finding/properties/locations/minItems",
                    keyword: "minItems",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 items",
                  };
                  if (vErrors === null) {
                    vErrors = [err104];
                  } else {
                    vErrors.push(err104);
                  }
                  errors++;
                }
                const len2 = data43.length;
                for (let i2 = 0; i2 < len2; i2++) {
                  let data44 = data43[i2];
                  if (
                    data44 &&
                    typeof data44 == "object" &&
                    !Array.isArray(data44)
                  ) {
                    if (data44.path === undefined) {
                      const err105 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/locations/" + i2,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "path" },
                        message: "must have required property '" + "path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err105];
                      } else {
                        vErrors.push(err105);
                      }
                      errors++;
                    }
                    if (data44.line_start === undefined) {
                      const err106 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/locations/" + i2,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_start" },
                        message:
                          "must have required property '" + "line_start" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err106];
                      } else {
                        vErrors.push(err106);
                      }
                      errors++;
                    }
                    if (data44.line_end === undefined) {
                      const err107 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/locations/" + i2,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_end" },
                        message:
                          "must have required property '" + "line_end" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err107];
                      } else {
                        vErrors.push(err107);
                      }
                      errors++;
                    }
                    if (data44.symbol_path === undefined) {
                      const err108 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/locations/" + i2,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "symbol_path" },
                        message:
                          "must have required property '" + "symbol_path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err108];
                      } else {
                        vErrors.push(err108);
                      }
                      errors++;
                    }
                    if (data44.occurrence_state === undefined) {
                      const err109 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/locations/" + i2,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "occurrence_state" },
                        message:
                          "must have required property '" +
                          "occurrence_state" +
                          "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err109];
                      } else {
                        vErrors.push(err109);
                      }
                      errors++;
                    }
                    for (const key5 in data44) {
                      if (!(
                        key5 === "path" ||
                        key5 === "line_start" ||
                        key5 === "line_end" ||
                        key5 === "column" ||
                        key5 === "symbol_path" ||
                        key5 === "occurrence_state" ||
                        key5 === "id"
                      )) {
                        const err110 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/locations/" +
                            i2,
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/additionalProperties",
                          keyword: "additionalProperties",
                          params: { additionalProperty: key5 },
                          message: "must NOT have additional properties",
                        };
                        if (vErrors === null) {
                          vErrors = [err110];
                        } else {
                          vErrors.push(err110);
                        }
                        errors++;
                      }
                    }
                    if (data44.path !== undefined) {
                      let data45 = data44.path;
                      if (typeof data45 === "string") {
                        if (func2(data45) < 1) {
                          const err111 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i0 +
                              "/locations/" +
                              i2 +
                              "/path",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/path/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err111];
                          } else {
                            vErrors.push(err111);
                          }
                          errors++;
                        }
                        if (!pattern8.test(data45)) {
                          const err112 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i0 +
                              "/locations/" +
                              i2 +
                              "/path",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/path/pattern",
                            keyword: "pattern",
                            params: {
                              pattern:
                                "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                            },
                            message:
                              'must match pattern "' +
                              "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                              '"',
                          };
                          if (vErrors === null) {
                            vErrors = [err112];
                          } else {
                            vErrors.push(err112);
                          }
                          errors++;
                        }
                      } else {
                        const err113 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/locations/" +
                            i2 +
                            "/path",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err113];
                        } else {
                          vErrors.push(err113);
                        }
                        errors++;
                      }
                    }
                    if (data44.line_start !== undefined) {
                      let data46 = data44.line_start;
                      if (!(
                        typeof data46 == "number" &&
                        !(data46 % 1) &&
                        !isNaN(data46)
                      )) {
                        const err114 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/locations/" +
                            i2 +
                            "/line_start",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/line_start/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err114];
                        } else {
                          vErrors.push(err114);
                        }
                        errors++;
                      }
                      if (typeof data46 == "number") {
                        if (data46 < 1 || isNaN(data46)) {
                          const err115 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i0 +
                              "/locations/" +
                              i2 +
                              "/line_start",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/line_start/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err115];
                          } else {
                            vErrors.push(err115);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data44.line_end !== undefined) {
                      let data47 = data44.line_end;
                      if (!(
                        typeof data47 == "number" &&
                        !(data47 % 1) &&
                        !isNaN(data47)
                      )) {
                        const err116 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/locations/" +
                            i2 +
                            "/line_end",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/line_end/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err116];
                        } else {
                          vErrors.push(err116);
                        }
                        errors++;
                      }
                      if (typeof data47 == "number") {
                        if (data47 < 1 || isNaN(data47)) {
                          const err117 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i0 +
                              "/locations/" +
                              i2 +
                              "/line_end",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/line_end/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err117];
                          } else {
                            vErrors.push(err117);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data44.column !== undefined) {
                      let data48 = data44.column;
                      if (!(
                        typeof data48 == "number" &&
                        !(data48 % 1) &&
                        !isNaN(data48)
                      )) {
                        const err118 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/locations/" +
                            i2 +
                            "/column",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/column/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err118];
                        } else {
                          vErrors.push(err118);
                        }
                        errors++;
                      }
                      if (typeof data48 == "number") {
                        if (data48 < 1 || isNaN(data48)) {
                          const err119 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i0 +
                              "/locations/" +
                              i2 +
                              "/column",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/column/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err119];
                          } else {
                            vErrors.push(err119);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data44.symbol_path !== undefined) {
                      if (typeof data44.symbol_path !== "string") {
                        const err120 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/locations/" +
                            i2 +
                            "/symbol_path",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/symbol_path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err120];
                        } else {
                          vErrors.push(err120);
                        }
                        errors++;
                      }
                    }
                    if (data44.occurrence_state !== undefined) {
                      let data50 = data44.occurrence_state;
                      if (!(
                        data50 === "new" ||
                        data50 === "pre-existing" ||
                        data50 === "fixed" ||
                        data50 === "unclassified"
                      )) {
                        const err121 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/locations/" +
                            i2 +
                            "/occurrence_state",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/occurrence_state/enum",
                          keyword: "enum",
                          params: {
                            allowedValues:
                              schema34.properties.locations.items.properties
                                .occurrence_state.enum,
                          },
                          message: "must be equal to one of the allowed values",
                        };
                        if (vErrors === null) {
                          vErrors = [err121];
                        } else {
                          vErrors.push(err121);
                        }
                        errors++;
                      }
                    }
                    if (data44.id !== undefined) {
                      let data51 = data44.id;
                      if (typeof data51 === "string") {
                        if (func2(data51) < 1) {
                          const err122 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i0 +
                              "/locations/" +
                              i2 +
                              "/id",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/id/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err122];
                          } else {
                            vErrors.push(err122);
                          }
                          errors++;
                        }
                      } else {
                        const err123 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/locations/" +
                            i2 +
                            "/id",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/id/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err123];
                        } else {
                          vErrors.push(err123);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err124 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/locations/" + i2,
                      schemaPath:
                        "#/$defs/finding/properties/locations/items/type",
                      keyword: "type",
                      params: { type: "object" },
                      message: "must be object",
                    };
                    if (vErrors === null) {
                      vErrors = [err124];
                    } else {
                      vErrors.push(err124);
                    }
                    errors++;
                  }
                }
              } else {
                const err125 = {
                  instancePath: instancePath + "/findings/" + i0 + "/locations",
                  schemaPath: "#/$defs/finding/properties/locations/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err125];
                } else {
                  vErrors.push(err125);
                }
                errors++;
              }
            }
            if (data18.advisory !== undefined) {
              let data52 = data18.advisory;
              if (
                data52 &&
                typeof data52 == "object" &&
                !Array.isArray(data52)
              ) {
                if (data52.id === undefined) {
                  const err126 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "id" },
                    message: "must have required property '" + "id" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err126];
                  } else {
                    vErrors.push(err126);
                  }
                  errors++;
                }
                if (data52.aliases === undefined) {
                  const err127 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "aliases" },
                    message: "must have required property '" + "aliases" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err127];
                  } else {
                    vErrors.push(err127);
                  }
                  errors++;
                }
                if (data52.severity === undefined) {
                  const err128 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "severity" },
                    message: "must have required property '" + "severity" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err128];
                  } else {
                    vErrors.push(err128);
                  }
                  errors++;
                }
                if (data52.fixed_version === undefined) {
                  const err129 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "fixed_version" },
                    message:
                      "must have required property '" + "fixed_version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err129];
                  } else {
                    vErrors.push(err129);
                  }
                  errors++;
                }
                if (data52.url === undefined) {
                  const err130 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "url" },
                    message: "must have required property '" + "url" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err130];
                  } else {
                    vErrors.push(err130);
                  }
                  errors++;
                }
                for (const key6 in data52) {
                  if (!(
                    key6 === "id" ||
                    key6 === "aliases" ||
                    key6 === "severity" ||
                    key6 === "fixed_version" ||
                    key6 === "url"
                  )) {
                    const err131 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/advisory",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key6 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err131];
                    } else {
                      vErrors.push(err131);
                    }
                    errors++;
                  }
                }
                if (data52.id !== undefined) {
                  let data53 = data52.id;
                  if (typeof data53 === "string") {
                    if (func2(data53) < 1) {
                      const err132 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/advisory/id",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/id/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err132];
                      } else {
                        vErrors.push(err132);
                      }
                      errors++;
                    }
                  } else {
                    const err133 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/advisory/id",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/id/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err133];
                    } else {
                      vErrors.push(err133);
                    }
                    errors++;
                  }
                }
                if (data52.aliases !== undefined) {
                  let data54 = data52.aliases;
                  if (Array.isArray(data54)) {
                    const len3 = data54.length;
                    for (let i3 = 0; i3 < len3; i3++) {
                      let data55 = data54[i3];
                      if (typeof data55 === "string") {
                        if (func2(data55) < 1) {
                          const err134 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i0 +
                              "/advisory/aliases/" +
                              i3,
                            schemaPath:
                              "#/$defs/finding/properties/advisory/properties/aliases/items/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err134];
                          } else {
                            vErrors.push(err134);
                          }
                          errors++;
                        }
                      } else {
                        const err135 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/advisory/aliases/" +
                            i3,
                          schemaPath:
                            "#/$defs/finding/properties/advisory/properties/aliases/items/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err135];
                        } else {
                          vErrors.push(err135);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err136 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/advisory/aliases",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/aliases/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err136];
                    } else {
                      vErrors.push(err136);
                    }
                    errors++;
                  }
                }
                if (data52.severity !== undefined) {
                  let data56 = data52.severity;
                  if (!(
                    data56 === "critical" ||
                    data56 === "high" ||
                    data56 === "moderate" ||
                    data56 === "low" ||
                    data56 === "unknown"
                  )) {
                    const err137 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/advisory/severity",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/severity/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.advisory.properties.severity.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err137];
                    } else {
                      vErrors.push(err137);
                    }
                    errors++;
                  }
                }
                if (data52.fixed_version !== undefined) {
                  let data57 = data52.fixed_version;
                  if (typeof data57 === "string") {
                    if (func2(data57) < 1) {
                      const err138 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i0 +
                          "/advisory/fixed_version",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/fixed_version/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err138];
                      } else {
                        vErrors.push(err138);
                      }
                      errors++;
                    }
                  } else {
                    const err139 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/advisory/fixed_version",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/fixed_version/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err139];
                    } else {
                      vErrors.push(err139);
                    }
                    errors++;
                  }
                }
                if (data52.url !== undefined) {
                  let data58 = data52.url;
                  if (typeof data58 === "string") {
                    if (!pattern10.test(data58)) {
                      const err140 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/advisory/url",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/url/pattern",
                        keyword: "pattern",
                        params: { pattern: "^https://" },
                        message: 'must match pattern "' + "^https://" + '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err140];
                      } else {
                        vErrors.push(err140);
                      }
                      errors++;
                    }
                  } else {
                    const err141 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/advisory/url",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/url/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err141];
                    } else {
                      vErrors.push(err141);
                    }
                    errors++;
                  }
                }
              } else {
                const err142 = {
                  instancePath: instancePath + "/findings/" + i0 + "/advisory",
                  schemaPath: "#/$defs/finding/properties/advisory/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err142];
                } else {
                  vErrors.push(err142);
                }
                errors++;
              }
            }
            if (data18.round !== undefined) {
              let data59 = data18.round;
              if (!(
                typeof data59 == "number" &&
                !(data59 % 1) &&
                !isNaN(data59)
              )) {
                const err143 = {
                  instancePath: instancePath + "/findings/" + i0 + "/round",
                  schemaPath: "#/$defs/finding/properties/round/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err143];
                } else {
                  vErrors.push(err143);
                }
                errors++;
              }
              if (typeof data59 == "number") {
                if (data59 < 1 || isNaN(data59)) {
                  const err144 = {
                    instancePath: instancePath + "/findings/" + i0 + "/round",
                    schemaPath: "#/$defs/finding/properties/round/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err144];
                  } else {
                    vErrors.push(err144);
                  }
                  errors++;
                }
              }
            }
            if (data18.first_posted_in !== undefined) {
              let data60 = data18.first_posted_in;
              if (typeof data60 === "string") {
                if (func2(data60) < 1) {
                  const err145 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/first_posted_in",
                    schemaPath:
                      "#/$defs/finding/properties/first_posted_in/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err145];
                  } else {
                    vErrors.push(err145);
                  }
                  errors++;
                }
              } else {
                const err146 = {
                  instancePath:
                    instancePath + "/findings/" + i0 + "/first_posted_in",
                  schemaPath: "#/$defs/finding/properties/first_posted_in/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err146];
                } else {
                  vErrors.push(err146);
                }
                errors++;
              }
            }
            if (data18.author_response !== undefined) {
              let data61 = data18.author_response;
              if (
                data61 &&
                typeof data61 == "object" &&
                !Array.isArray(data61)
              ) {
                if (data61.reason === undefined) {
                  const err147 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "reason" },
                    message: "must have required property '" + "reason" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err147];
                  } else {
                    vErrors.push(err147);
                  }
                  errors++;
                }
                if (data61.actor === undefined) {
                  const err148 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "actor" },
                    message: "must have required property '" + "actor" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err148];
                  } else {
                    vErrors.push(err148);
                  }
                  errors++;
                }
                if (data61.at === undefined) {
                  const err149 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "at" },
                    message: "must have required property '" + "at" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err149];
                  } else {
                    vErrors.push(err149);
                  }
                  errors++;
                }
                for (const key7 in data61) {
                  if (!(
                    key7 === "reason" ||
                    key7 === "actor" ||
                    key7 === "at" ||
                    key7 === "note"
                  )) {
                    const err150 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/author_response",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key7 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err150];
                    } else {
                      vErrors.push(err150);
                    }
                    errors++;
                  }
                }
                if (data61.reason !== undefined) {
                  let data62 = data61.reason;
                  if (!(
                    data62 === "fixed" ||
                    data62 === "wrong" ||
                    data62 === "intentional" ||
                    data62 === "irrelevant" ||
                    data62 === "style"
                  )) {
                    const err151 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/author_response/reason",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/reason/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.author_response.properties.reason
                            .enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err151];
                    } else {
                      vErrors.push(err151);
                    }
                    errors++;
                  }
                }
                if (data61.actor !== undefined) {
                  let data63 = data61.actor;
                  if (typeof data63 === "string") {
                    if (func2(data63) < 1) {
                      const err152 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i0 +
                          "/author_response/actor",
                        schemaPath:
                          "#/$defs/finding/properties/author_response/properties/actor/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err152];
                      } else {
                        vErrors.push(err152);
                      }
                      errors++;
                    }
                  } else {
                    const err153 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/author_response/actor",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/actor/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err153];
                    } else {
                      vErrors.push(err153);
                    }
                    errors++;
                  }
                }
                if (data61.at !== undefined) {
                  let data64 = data61.at;
                  if (typeof data64 === "string") {
                    if (!formats0.validate(data64)) {
                      const err154 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i0 +
                          "/author_response/at",
                        schemaPath:
                          "#/$defs/finding/properties/author_response/properties/at/format",
                        keyword: "format",
                        params: { format: "date-time" },
                        message: 'must match format "' + "date-time" + '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err154];
                      } else {
                        vErrors.push(err154);
                      }
                      errors++;
                    }
                  } else {
                    const err155 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/author_response/at",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/at/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err155];
                    } else {
                      vErrors.push(err155);
                    }
                    errors++;
                  }
                }
                if (data61.note !== undefined) {
                  if (typeof data61.note !== "string") {
                    const err156 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/author_response/note",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/note/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err156];
                    } else {
                      vErrors.push(err156);
                    }
                    errors++;
                  }
                }
              } else {
                const err157 = {
                  instancePath:
                    instancePath + "/findings/" + i0 + "/author_response",
                  schemaPath: "#/$defs/finding/properties/author_response/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err157];
                } else {
                  vErrors.push(err157);
                }
                errors++;
              }
            }
            if (data18.status !== undefined) {
              let data66 = data18.status;
              if (!(
                data66 === "open" ||
                data66 === "fixed" ||
                data66 === "dismissed"
              )) {
                const err158 = {
                  instancePath: instancePath + "/findings/" + i0 + "/status",
                  schemaPath: "#/$defs/finding/properties/status/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.status.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err158];
                } else {
                  vErrors.push(err158);
                }
                errors++;
              }
            }
            if (data18.resolution !== undefined) {
              let data67 = data18.resolution;
              if (
                data67 &&
                typeof data67 == "object" &&
                !Array.isArray(data67)
              ) {
                for (const key8 in data67) {
                  if (!(key8 === "fixed_in" || key8 === "note")) {
                    const err159 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/resolution",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key8 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err159];
                    } else {
                      vErrors.push(err159);
                    }
                    errors++;
                  }
                }
                if (data67.fixed_in !== undefined) {
                  let data68 = data67.fixed_in;
                  if (typeof data68 === "string") {
                    if (func2(data68) < 1) {
                      const err160 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i0 +
                          "/resolution/fixed_in",
                        schemaPath:
                          "#/$defs/finding/properties/resolution/properties/fixed_in/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err160];
                      } else {
                        vErrors.push(err160);
                      }
                      errors++;
                    }
                  } else {
                    const err161 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/resolution/fixed_in",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/properties/fixed_in/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err161];
                    } else {
                      vErrors.push(err161);
                    }
                    errors++;
                  }
                }
                if (data67.note !== undefined) {
                  let data69 = data67.note;
                  if (typeof data69 === "string") {
                    if (func2(data69) < 1) {
                      const err162 = {
                        instancePath:
                          instancePath + "/findings/" + i0 + "/resolution/note",
                        schemaPath:
                          "#/$defs/finding/properties/resolution/properties/note/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err162];
                      } else {
                        vErrors.push(err162);
                      }
                      errors++;
                    }
                  } else {
                    const err163 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/resolution/note",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/properties/note/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err163];
                    } else {
                      vErrors.push(err163);
                    }
                    errors++;
                  }
                }
              } else {
                const err164 = {
                  instancePath:
                    instancePath + "/findings/" + i0 + "/resolution",
                  schemaPath: "#/$defs/finding/properties/resolution/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err164];
                } else {
                  vErrors.push(err164);
                }
                errors++;
              }
            }
            if (data18.verification !== undefined) {
              let data70 = data18.verification;
              if (
                data70 &&
                typeof data70 == "object" &&
                !Array.isArray(data70)
              ) {
                if (data70.voters === undefined) {
                  const err165 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "voters" },
                    message: "must have required property '" + "voters" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err165];
                  } else {
                    vErrors.push(err165);
                  }
                  errors++;
                }
                if (data70.agreeing === undefined) {
                  const err166 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "agreeing" },
                    message: "must have required property '" + "agreeing" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err166];
                  } else {
                    vErrors.push(err166);
                  }
                  errors++;
                }
                if (data70.blind_match === undefined) {
                  const err167 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "blind_match" },
                    message:
                      "must have required property '" + "blind_match" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err167];
                  } else {
                    vErrors.push(err167);
                  }
                  errors++;
                }
                if (data70.split === undefined) {
                  const err168 = {
                    instancePath:
                      instancePath + "/findings/" + i0 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "split" },
                    message: "must have required property '" + "split" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err168];
                  } else {
                    vErrors.push(err168);
                  }
                  errors++;
                }
                for (const key9 in data70) {
                  if (!(
                    key9 === "voters" ||
                    key9 === "agreeing" ||
                    key9 === "blind_match" ||
                    key9 === "split"
                  )) {
                    const err169 = {
                      instancePath:
                        instancePath + "/findings/" + i0 + "/verification",
                      schemaPath:
                        "#/$defs/finding/properties/verification/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key9 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err169];
                    } else {
                      vErrors.push(err169);
                    }
                    errors++;
                  }
                }
                if (data70.voters !== undefined) {
                  let data71 = data70.voters;
                  if (!(
                    typeof data71 == "number" &&
                    !(data71 % 1) &&
                    !isNaN(data71)
                  )) {
                    const err170 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/verification/voters",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/voters/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err170];
                    } else {
                      vErrors.push(err170);
                    }
                    errors++;
                  }
                  if (typeof data71 == "number") {
                    if (data71 < 1 || isNaN(data71)) {
                      const err171 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i0 +
                          "/verification/voters",
                        schemaPath:
                          "#/$defs/finding/properties/verification/properties/voters/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err171];
                      } else {
                        vErrors.push(err171);
                      }
                      errors++;
                    }
                  }
                }
                if (data70.agreeing !== undefined) {
                  let data72 = data70.agreeing;
                  if (!(
                    typeof data72 == "number" &&
                    !(data72 % 1) &&
                    !isNaN(data72)
                  )) {
                    const err172 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/verification/agreeing",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/agreeing/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err172];
                    } else {
                      vErrors.push(err172);
                    }
                    errors++;
                  }
                  if (typeof data72 == "number") {
                    if (data72 < 0 || isNaN(data72)) {
                      const err173 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i0 +
                          "/verification/agreeing",
                        schemaPath:
                          "#/$defs/finding/properties/verification/properties/agreeing/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 0 },
                        message: "must be >= 0",
                      };
                      if (vErrors === null) {
                        vErrors = [err173];
                      } else {
                        vErrors.push(err173);
                      }
                      errors++;
                    }
                  }
                }
                if (data70.blind_match !== undefined) {
                  let data73 = data70.blind_match;
                  if (Array.isArray(data73)) {
                    const len4 = data73.length;
                    for (let i4 = 0; i4 < len4; i4++) {
                      let data74 = data73[i4];
                      if (!(
                        data74 === "same" ||
                        data74 === "related" ||
                        data74 === "none"
                      )) {
                        const err174 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i0 +
                            "/verification/blind_match/" +
                            i4,
                          schemaPath:
                            "#/$defs/finding/properties/verification/properties/blind_match/items/enum",
                          keyword: "enum",
                          params: {
                            allowedValues:
                              schema34.properties.verification.properties
                                .blind_match.items.enum,
                          },
                          message: "must be equal to one of the allowed values",
                        };
                        if (vErrors === null) {
                          vErrors = [err174];
                        } else {
                          vErrors.push(err174);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err175 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/verification/blind_match",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/blind_match/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err175];
                    } else {
                      vErrors.push(err175);
                    }
                    errors++;
                  }
                }
                if (data70.split !== undefined) {
                  if (typeof data70.split !== "boolean") {
                    const err176 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i0 +
                        "/verification/split",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/split/type",
                      keyword: "type",
                      params: { type: "boolean" },
                      message: "must be boolean",
                    };
                    if (vErrors === null) {
                      vErrors = [err176];
                    } else {
                      vErrors.push(err176);
                    }
                    errors++;
                  }
                }
              } else {
                const err177 = {
                  instancePath:
                    instancePath + "/findings/" + i0 + "/verification",
                  schemaPath: "#/$defs/finding/properties/verification/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err177];
                } else {
                  vErrors.push(err177);
                }
                errors++;
              }
            }
          } else {
            const err178 = {
              instancePath: instancePath + "/findings/" + i0,
              schemaPath: "#/$defs/finding/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err178];
            } else {
              vErrors.push(err178);
            }
            errors++;
          }
        }
      } else {
        const err179 = {
          instancePath: instancePath + "/findings",
          schemaPath: "#/properties/findings/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err179];
        } else {
          vErrors.push(err179);
        }
        errors++;
      }
    }
    if (data.cached !== undefined) {
      if (typeof data.cached !== "boolean") {
        const err180 = {
          instancePath: instancePath + "/cached",
          schemaPath: "#/properties/cached/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err180];
        } else {
          vErrors.push(err180);
        }
        errors++;
      }
    }
  } else {
    const err181 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err181];
    } else {
      vErrors.push(err181);
    }
    errors++;
  }
  validate22.errors = vErrors;
  return errors === 0;
}
validate22.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
function validate21(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  /*# sourceURL="https://rio.dev/schemas/report-v1.json" */ let vErrors = null;
  let errors = 0;
  const evaluated0 = validate21.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  const _errs2 = errors;
  let valid1 = true;
  const _errs3 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.status !== undefined) {
      if ("error" !== data.status) {
        const err0 = {};
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
  }
  var _valid0 = _errs3 === errors;
  errors = _errs2;
  if (vErrors !== null) {
    if (_errs2) {
      vErrors.length = _errs2;
    } else {
      vErrors = null;
    }
  }
  let ifClause0;
  if (_valid0) {
    const _errs5 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.error === undefined) {
        const err1 = {
          instancePath,
          schemaPath: "#/allOf/0/then/required",
          keyword: "required",
          params: { missingProperty: "error" },
          message: "must have required property '" + "error" + "'",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    var _valid0 = _errs5 === errors;
    valid1 = _valid0;
    ifClause0 = "then";
  } else {
    const _errs6 = errors;
    const _errs7 = errors;
    const _errs8 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.error === undefined && (missing0 = "error")) {
        const err2 = {};
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    var valid3 = _errs8 === errors;
    if (valid3) {
      const err3 = {
        instancePath,
        schemaPath: "#/allOf/0/else/not",
        keyword: "not",
        params: {},
        message: "must NOT be valid",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    } else {
      errors = _errs7;
      if (vErrors !== null) {
        if (_errs7) {
          vErrors.length = _errs7;
        } else {
          vErrors = null;
        }
      }
    }
    var _valid0 = _errs6 === errors;
    valid1 = _valid0;
    ifClause0 = "else";
  }
  if (!valid1) {
    const err4 = {
      instancePath,
      schemaPath: "#/allOf/0/if",
      keyword: "if",
      params: { failingKeyword: ifClause0 },
      message: 'must match "' + ifClause0 + '" schema',
    };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.schema === undefined) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "schema" },
        message: "must have required property '" + "schema" + "'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.status === undefined) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "status" },
        message: "must have required property '" + "status" + "'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.review === undefined) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "review" },
        message: "must have required property '" + "review" + "'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.checks === undefined) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "checks" },
        message: "must have required property '" + "checks" + "'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (data.impact === undefined) {
      const err9 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "impact" },
        message: "must have required property '" + "impact" + "'",
      };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    if (data.findings === undefined) {
      const err10 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "findings" },
        message: "must have required property '" + "findings" + "'",
      };
      if (vErrors === null) {
        vErrors = [err10];
      } else {
        vErrors.push(err10);
      }
      errors++;
    }
    if (data.risks === undefined) {
      const err11 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "risks" },
        message: "must have required property '" + "risks" + "'",
      };
      if (vErrors === null) {
        vErrors = [err11];
      } else {
        vErrors.push(err11);
      }
      errors++;
    }
    if (data.incomplete === undefined) {
      const err12 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "incomplete" },
        message: "must have required property '" + "incomplete" + "'",
      };
      if (vErrors === null) {
        vErrors = [err12];
      } else {
        vErrors.push(err12);
      }
      errors++;
    }
    if (data.deferred === undefined) {
      const err13 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "deferred" },
        message: "must have required property '" + "deferred" + "'",
      };
      if (vErrors === null) {
        vErrors = [err13];
      } else {
        vErrors.push(err13);
      }
      errors++;
    }
    if (data.excluded === undefined) {
      const err14 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "excluded" },
        message: "must have required property '" + "excluded" + "'",
      };
      if (vErrors === null) {
        vErrors = [err14];
      } else {
        vErrors.push(err14);
      }
      errors++;
    }
    if (data.metrics === undefined) {
      const err15 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "metrics" },
        message: "must have required property '" + "metrics" + "'",
      };
      if (vErrors === null) {
        vErrors = [err15];
      } else {
        vErrors.push(err15);
      }
      errors++;
    }
    if (data.summary === undefined) {
      const err16 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "summary" },
        message: "must have required property '" + "summary" + "'",
      };
      if (vErrors === null) {
        vErrors = [err16];
      } else {
        vErrors.push(err16);
      }
      errors++;
    }
    if (data.footer === undefined) {
      const err17 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "footer" },
        message: "must have required property '" + "footer" + "'",
      };
      if (vErrors === null) {
        vErrors = [err17];
      } else {
        vErrors.push(err17);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema32.properties, key0)) {
        const err18 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
    }
    if (data.schema !== undefined) {
      if ("rio-report-v1" !== data.schema) {
        const err19 = {
          instancePath: instancePath + "/schema",
          schemaPath: "#/properties/schema/const",
          keyword: "const",
          params: { allowedValue: "rio-report-v1" },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
    }
    if (data.status !== undefined) {
      let data2 = data.status;
      if (!(
        data2 === "complete" ||
        data2 === "incomplete" ||
        data2 === "partial" ||
        data2 === "no_changes" ||
        data2 === "error"
      )) {
        const err20 = {
          instancePath: instancePath + "/status",
          schemaPath: "#/properties/status/enum",
          keyword: "enum",
          params: { allowedValues: schema32.properties.status.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
    }
    if (data.review !== undefined) {
      let data3 = data.review;
      if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
        if (data3.rio_version === undefined) {
          const err21 = {
            instancePath: instancePath + "/review",
            schemaPath: "#/properties/review/required",
            keyword: "required",
            params: { missingProperty: "rio_version" },
            message: "must have required property '" + "rio_version" + "'",
          };
          if (vErrors === null) {
            vErrors = [err21];
          } else {
            vErrors.push(err21);
          }
          errors++;
        }
        for (const key1 in data3) {
          if (!(
            key1 === "id" ||
            key1 === "run_id" ||
            key1 === "mode" ||
            key1 === "base" ||
            key1 === "head" ||
            key1 === "profile" ||
            key1 === "chain" ||
            key1 === "rio_version"
          )) {
            const err22 = {
              instancePath: instancePath + "/review",
              schemaPath: "#/properties/review/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key1 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err22];
            } else {
              vErrors.push(err22);
            }
            errors++;
          }
        }
        if (data3.id !== undefined) {
          let data4 = data3.id;
          if (typeof data4 === "string") {
            if (func2(data4) < 1) {
              const err23 = {
                instancePath: instancePath + "/review/id",
                schemaPath: "#/properties/review/properties/id/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err23];
              } else {
                vErrors.push(err23);
              }
              errors++;
            }
          } else {
            const err24 = {
              instancePath: instancePath + "/review/id",
              schemaPath: "#/properties/review/properties/id/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err24];
            } else {
              vErrors.push(err24);
            }
            errors++;
          }
        }
        if (data3.run_id !== undefined) {
          let data5 = data3.run_id;
          if (typeof data5 === "string") {
            if (func2(data5) < 1) {
              const err25 = {
                instancePath: instancePath + "/review/run_id",
                schemaPath: "#/properties/review/properties/run_id/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err25];
              } else {
                vErrors.push(err25);
              }
              errors++;
            }
          } else {
            const err26 = {
              instancePath: instancePath + "/review/run_id",
              schemaPath: "#/properties/review/properties/run_id/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err26];
            } else {
              vErrors.push(err26);
            }
            errors++;
          }
        }
        if (data3.mode !== undefined) {
          let data6 = data3.mode;
          if (!(
            data6 === "working-tree" ||
            data6 === "staged" ||
            data6 === "branch"
          )) {
            const err27 = {
              instancePath: instancePath + "/review/mode",
              schemaPath: "#/properties/review/properties/mode/enum",
              keyword: "enum",
              params: {
                allowedValues: schema32.properties.review.properties.mode.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err27];
            } else {
              vErrors.push(err27);
            }
            errors++;
          }
        }
        if (data3.base !== undefined) {
          let data7 = data3.base;
          if (typeof data7 === "string") {
            if (func2(data7) < 1) {
              const err28 = {
                instancePath: instancePath + "/review/base",
                schemaPath: "#/properties/review/properties/base/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err28];
              } else {
                vErrors.push(err28);
              }
              errors++;
            }
          } else {
            const err29 = {
              instancePath: instancePath + "/review/base",
              schemaPath: "#/properties/review/properties/base/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err29];
            } else {
              vErrors.push(err29);
            }
            errors++;
          }
        }
        if (data3.head !== undefined) {
          let data8 = data3.head;
          if (typeof data8 === "string") {
            if (func2(data8) < 1) {
              const err30 = {
                instancePath: instancePath + "/review/head",
                schemaPath: "#/properties/review/properties/head/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err30];
              } else {
                vErrors.push(err30);
              }
              errors++;
            }
          } else {
            const err31 = {
              instancePath: instancePath + "/review/head",
              schemaPath: "#/properties/review/properties/head/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err31];
            } else {
              vErrors.push(err31);
            }
            errors++;
          }
        }
        if (data3.profile !== undefined) {
          let data9 = data3.profile;
          if (typeof data9 === "string") {
            if (func2(data9) < 1) {
              const err32 = {
                instancePath: instancePath + "/review/profile",
                schemaPath: "#/properties/review/properties/profile/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err32];
              } else {
                vErrors.push(err32);
              }
              errors++;
            }
          } else {
            const err33 = {
              instancePath: instancePath + "/review/profile",
              schemaPath: "#/properties/review/properties/profile/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err33];
            } else {
              vErrors.push(err33);
            }
            errors++;
          }
        }
        if (data3.chain !== undefined) {
          let data10 = data3.chain;
          if (Array.isArray(data10)) {
            const len0 = data10.length;
            for (let i0 = 0; i0 < len0; i0++) {
              let data11 = data10[i0];
              if (typeof data11 === "string") {
                if (func2(data11) < 1) {
                  const err34 = {
                    instancePath: instancePath + "/review/chain/" + i0,
                    schemaPath:
                      "#/properties/review/properties/chain/items/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err34];
                  } else {
                    vErrors.push(err34);
                  }
                  errors++;
                }
              } else {
                const err35 = {
                  instancePath: instancePath + "/review/chain/" + i0,
                  schemaPath: "#/properties/review/properties/chain/items/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err35];
                } else {
                  vErrors.push(err35);
                }
                errors++;
              }
            }
          } else {
            const err36 = {
              instancePath: instancePath + "/review/chain",
              schemaPath: "#/properties/review/properties/chain/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err36];
            } else {
              vErrors.push(err36);
            }
            errors++;
          }
        }
        if (data3.rio_version !== undefined) {
          let data12 = data3.rio_version;
          if (typeof data12 === "string") {
            if (func2(data12) < 1) {
              const err37 = {
                instancePath: instancePath + "/review/rio_version",
                schemaPath:
                  "#/properties/review/properties/rio_version/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err37];
              } else {
                vErrors.push(err37);
              }
              errors++;
            }
          } else {
            const err38 = {
              instancePath: instancePath + "/review/rio_version",
              schemaPath: "#/properties/review/properties/rio_version/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err38];
            } else {
              vErrors.push(err38);
            }
            errors++;
          }
        }
      } else {
        const err39 = {
          instancePath: instancePath + "/review",
          schemaPath: "#/properties/review/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err39];
        } else {
          vErrors.push(err39);
        }
        errors++;
      }
    }
    if (data.checks !== undefined) {
      let data13 = data.checks;
      if (Array.isArray(data13)) {
        const len1 = data13.length;
        for (let i1 = 0; i1 < len1; i1++) {
          if (
            !validate22(data13[i1], {
              instancePath: instancePath + "/checks/" + i1,
              parentData: data13,
              parentDataProperty: i1,
              rootData,
              dynamicAnchors,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate22.errors
                : vErrors.concat(validate22.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err40 = {
          instancePath: instancePath + "/checks",
          schemaPath: "#/properties/checks/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err40];
        } else {
          vErrors.push(err40);
        }
        errors++;
      }
    }
    if (data.impact !== undefined) {
      let data15 = data.impact;
      if (data15 && typeof data15 == "object" && !Array.isArray(data15)) {
        if (data15.symbols === undefined) {
          const err41 = {
            instancePath: instancePath + "/impact",
            schemaPath: "#/properties/impact/required",
            keyword: "required",
            params: { missingProperty: "symbols" },
            message: "must have required property '" + "symbols" + "'",
          };
          if (vErrors === null) {
            vErrors = [err41];
          } else {
            vErrors.push(err41);
          }
          errors++;
        }
        if (data15.unresolved === undefined) {
          const err42 = {
            instancePath: instancePath + "/impact",
            schemaPath: "#/properties/impact/required",
            keyword: "required",
            params: { missingProperty: "unresolved" },
            message: "must have required property '" + "unresolved" + "'",
          };
          if (vErrors === null) {
            vErrors = [err42];
          } else {
            vErrors.push(err42);
          }
          errors++;
        }
        if (data15.truncated === undefined) {
          const err43 = {
            instancePath: instancePath + "/impact",
            schemaPath: "#/properties/impact/required",
            keyword: "required",
            params: { missingProperty: "truncated" },
            message: "must have required property '" + "truncated" + "'",
          };
          if (vErrors === null) {
            vErrors = [err43];
          } else {
            vErrors.push(err43);
          }
          errors++;
        }
        for (const key2 in data15) {
          if (!(
            key2 === "symbols" ||
            key2 === "unresolved" ||
            key2 === "truncated"
          )) {
            const err44 = {
              instancePath: instancePath + "/impact",
              schemaPath: "#/properties/impact/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key2 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err44];
            } else {
              vErrors.push(err44);
            }
            errors++;
          }
        }
        if (data15.symbols !== undefined) {
          let data16 = data15.symbols;
          if (Array.isArray(data16)) {
            const len2 = data16.length;
            for (let i2 = 0; i2 < len2; i2++) {
              let data17 = data16[i2];
              if (
                data17 &&
                typeof data17 == "object" &&
                !Array.isArray(data17)
              ) {
                if (data17.path === undefined) {
                  const err45 = {
                    instancePath: instancePath + "/impact/symbols/" + i2,
                    schemaPath:
                      "#/properties/impact/properties/symbols/items/required",
                    keyword: "required",
                    params: { missingProperty: "path" },
                    message: "must have required property '" + "path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err45];
                  } else {
                    vErrors.push(err45);
                  }
                  errors++;
                }
                if (data17.symbol_path === undefined) {
                  const err46 = {
                    instancePath: instancePath + "/impact/symbols/" + i2,
                    schemaPath:
                      "#/properties/impact/properties/symbols/items/required",
                    keyword: "required",
                    params: { missingProperty: "symbol_path" },
                    message:
                      "must have required property '" + "symbol_path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err46];
                  } else {
                    vErrors.push(err46);
                  }
                  errors++;
                }
                if (data17.references_per_hop === undefined) {
                  const err47 = {
                    instancePath: instancePath + "/impact/symbols/" + i2,
                    schemaPath:
                      "#/properties/impact/properties/symbols/items/required",
                    keyword: "required",
                    params: { missingProperty: "references_per_hop" },
                    message:
                      "must have required property '" +
                      "references_per_hop" +
                      "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err47];
                  } else {
                    vErrors.push(err47);
                  }
                  errors++;
                }
                if (data17.test_referenced === undefined) {
                  const err48 = {
                    instancePath: instancePath + "/impact/symbols/" + i2,
                    schemaPath:
                      "#/properties/impact/properties/symbols/items/required",
                    keyword: "required",
                    params: { missingProperty: "test_referenced" },
                    message:
                      "must have required property '" + "test_referenced" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err48];
                  } else {
                    vErrors.push(err48);
                  }
                  errors++;
                }
                if (data17.unresolved === undefined) {
                  const err49 = {
                    instancePath: instancePath + "/impact/symbols/" + i2,
                    schemaPath:
                      "#/properties/impact/properties/symbols/items/required",
                    keyword: "required",
                    params: { missingProperty: "unresolved" },
                    message:
                      "must have required property '" + "unresolved" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err49];
                  } else {
                    vErrors.push(err49);
                  }
                  errors++;
                }
                for (const key3 in data17) {
                  if (!(
                    key3 === "path" ||
                    key3 === "symbol_path" ||
                    key3 === "references_per_hop" ||
                    key3 === "test_referenced" ||
                    key3 === "unresolved"
                  )) {
                    const err50 = {
                      instancePath: instancePath + "/impact/symbols/" + i2,
                      schemaPath:
                        "#/properties/impact/properties/symbols/items/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key3 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err50];
                    } else {
                      vErrors.push(err50);
                    }
                    errors++;
                  }
                }
                if (data17.path !== undefined) {
                  let data18 = data17.path;
                  if (typeof data18 === "string") {
                    if (func2(data18) < 1) {
                      const err51 = {
                        instancePath:
                          instancePath + "/impact/symbols/" + i2 + "/path",
                        schemaPath:
                          "#/properties/impact/properties/symbols/items/properties/path/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err51];
                      } else {
                        vErrors.push(err51);
                      }
                      errors++;
                    }
                  } else {
                    const err52 = {
                      instancePath:
                        instancePath + "/impact/symbols/" + i2 + "/path",
                      schemaPath:
                        "#/properties/impact/properties/symbols/items/properties/path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err52];
                    } else {
                      vErrors.push(err52);
                    }
                    errors++;
                  }
                }
                if (data17.symbol_path !== undefined) {
                  if (typeof data17.symbol_path !== "string") {
                    const err53 = {
                      instancePath:
                        instancePath + "/impact/symbols/" + i2 + "/symbol_path",
                      schemaPath:
                        "#/properties/impact/properties/symbols/items/properties/symbol_path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err53];
                    } else {
                      vErrors.push(err53);
                    }
                    errors++;
                  }
                }
                if (data17.references_per_hop !== undefined) {
                  let data20 = data17.references_per_hop;
                  if (Array.isArray(data20)) {
                    const len3 = data20.length;
                    for (let i3 = 0; i3 < len3; i3++) {
                      let data21 = data20[i3];
                      if (!(
                        typeof data21 == "number" &&
                        !(data21 % 1) &&
                        !isNaN(data21)
                      )) {
                        const err54 = {
                          instancePath:
                            instancePath +
                            "/impact/symbols/" +
                            i2 +
                            "/references_per_hop/" +
                            i3,
                          schemaPath:
                            "#/properties/impact/properties/symbols/items/properties/references_per_hop/items/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err54];
                        } else {
                          vErrors.push(err54);
                        }
                        errors++;
                      }
                      if (typeof data21 == "number") {
                        if (data21 < 0 || isNaN(data21)) {
                          const err55 = {
                            instancePath:
                              instancePath +
                              "/impact/symbols/" +
                              i2 +
                              "/references_per_hop/" +
                              i3,
                            schemaPath:
                              "#/properties/impact/properties/symbols/items/properties/references_per_hop/items/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 0 },
                            message: "must be >= 0",
                          };
                          if (vErrors === null) {
                            vErrors = [err55];
                          } else {
                            vErrors.push(err55);
                          }
                          errors++;
                        }
                      }
                    }
                  } else {
                    const err56 = {
                      instancePath:
                        instancePath +
                        "/impact/symbols/" +
                        i2 +
                        "/references_per_hop",
                      schemaPath:
                        "#/properties/impact/properties/symbols/items/properties/references_per_hop/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err56];
                    } else {
                      vErrors.push(err56);
                    }
                    errors++;
                  }
                }
                if (data17.test_referenced !== undefined) {
                  if (typeof data17.test_referenced !== "boolean") {
                    const err57 = {
                      instancePath:
                        instancePath +
                        "/impact/symbols/" +
                        i2 +
                        "/test_referenced",
                      schemaPath:
                        "#/properties/impact/properties/symbols/items/properties/test_referenced/type",
                      keyword: "type",
                      params: { type: "boolean" },
                      message: "must be boolean",
                    };
                    if (vErrors === null) {
                      vErrors = [err57];
                    } else {
                      vErrors.push(err57);
                    }
                    errors++;
                  }
                }
                if (data17.unresolved !== undefined) {
                  let data23 = data17.unresolved;
                  if (!(
                    typeof data23 == "number" &&
                    !(data23 % 1) &&
                    !isNaN(data23)
                  )) {
                    const err58 = {
                      instancePath:
                        instancePath + "/impact/symbols/" + i2 + "/unresolved",
                      schemaPath:
                        "#/properties/impact/properties/symbols/items/properties/unresolved/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err58];
                    } else {
                      vErrors.push(err58);
                    }
                    errors++;
                  }
                  if (typeof data23 == "number") {
                    if (data23 < 0 || isNaN(data23)) {
                      const err59 = {
                        instancePath:
                          instancePath +
                          "/impact/symbols/" +
                          i2 +
                          "/unresolved",
                        schemaPath:
                          "#/properties/impact/properties/symbols/items/properties/unresolved/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 0 },
                        message: "must be >= 0",
                      };
                      if (vErrors === null) {
                        vErrors = [err59];
                      } else {
                        vErrors.push(err59);
                      }
                      errors++;
                    }
                  }
                }
              } else {
                const err60 = {
                  instancePath: instancePath + "/impact/symbols/" + i2,
                  schemaPath:
                    "#/properties/impact/properties/symbols/items/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err60];
                } else {
                  vErrors.push(err60);
                }
                errors++;
              }
            }
          } else {
            const err61 = {
              instancePath: instancePath + "/impact/symbols",
              schemaPath: "#/properties/impact/properties/symbols/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err61];
            } else {
              vErrors.push(err61);
            }
            errors++;
          }
        }
        if (data15.unresolved !== undefined) {
          let data24 = data15.unresolved;
          if (!(typeof data24 == "number" && !(data24 % 1) && !isNaN(data24))) {
            const err62 = {
              instancePath: instancePath + "/impact/unresolved",
              schemaPath: "#/properties/impact/properties/unresolved/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err62];
            } else {
              vErrors.push(err62);
            }
            errors++;
          }
          if (typeof data24 == "number") {
            if (data24 < 0 || isNaN(data24)) {
              const err63 = {
                instancePath: instancePath + "/impact/unresolved",
                schemaPath: "#/properties/impact/properties/unresolved/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err63];
              } else {
                vErrors.push(err63);
              }
              errors++;
            }
          }
        }
        if (data15.truncated !== undefined) {
          if (typeof data15.truncated !== "boolean") {
            const err64 = {
              instancePath: instancePath + "/impact/truncated",
              schemaPath: "#/properties/impact/properties/truncated/type",
              keyword: "type",
              params: { type: "boolean" },
              message: "must be boolean",
            };
            if (vErrors === null) {
              vErrors = [err64];
            } else {
              vErrors.push(err64);
            }
            errors++;
          }
        }
      } else {
        const err65 = {
          instancePath: instancePath + "/impact",
          schemaPath: "#/properties/impact/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err65];
        } else {
          vErrors.push(err65);
        }
        errors++;
      }
    }
    if (data.findings !== undefined) {
      let data26 = data.findings;
      if (Array.isArray(data26)) {
        const len4 = data26.length;
        for (let i4 = 0; i4 < len4; i4++) {
          let data27 = data26[i4];
          const _errs65 = errors;
          let valid20 = true;
          const _errs66 = errors;
          if (data27 && typeof data27 == "object" && !Array.isArray(data27)) {
            if (data27.rule_id !== undefined) {
              let data28 = data27.rule_id;
              if (typeof data28 === "string") {
                if (!pattern6.test(data28)) {
                  const err66 = {};
                  if (vErrors === null) {
                    vErrors = [err66];
                  } else {
                    vErrors.push(err66);
                  }
                  errors++;
                }
              }
            }
          }
          var _valid1 = _errs66 === errors;
          errors = _errs65;
          if (vErrors !== null) {
            if (_errs65) {
              vErrors.length = _errs65;
            } else {
              vErrors = null;
            }
          }
          if (_valid1) {
            const _errs68 = errors;
            if (data27 && typeof data27 == "object" && !Array.isArray(data27)) {
              if (data27.advisory === undefined) {
                const err67 = {
                  instancePath: instancePath + "/findings/" + i4,
                  schemaPath: "#/$defs/finding/allOf/0/then/required",
                  keyword: "required",
                  params: { missingProperty: "advisory" },
                  message: "must have required property '" + "advisory" + "'",
                };
                if (vErrors === null) {
                  vErrors = [err67];
                } else {
                  vErrors.push(err67);
                }
                errors++;
              }
            }
            var _valid1 = _errs68 === errors;
            valid20 = _valid1;
          }
          if (!valid20) {
            const err68 = {
              instancePath: instancePath + "/findings/" + i4,
              schemaPath: "#/$defs/finding/allOf/0/if",
              keyword: "if",
              params: { failingKeyword: "then" },
              message: 'must match "then" schema',
            };
            if (vErrors === null) {
              vErrors = [err68];
            } else {
              vErrors.push(err68);
            }
            errors++;
          }
          if (data27 && typeof data27 == "object" && !Array.isArray(data27)) {
            if (data27.id === undefined) {
              const err69 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "id" },
                message: "must have required property '" + "id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err69];
              } else {
                vErrors.push(err69);
              }
              errors++;
            }
            if (data27.rule_id === undefined) {
              const err70 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "rule_id" },
                message: "must have required property '" + "rule_id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err70];
              } else {
                vErrors.push(err70);
              }
              errors++;
            }
            if (data27.category === undefined) {
              const err71 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "category" },
                message: "must have required property '" + "category" + "'",
              };
              if (vErrors === null) {
                vErrors = [err71];
              } else {
                vErrors.push(err71);
              }
              errors++;
            }
            if (data27.evidence_level === undefined) {
              const err72 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "evidence_level" },
                message:
                  "must have required property '" + "evidence_level" + "'",
              };
              if (vErrors === null) {
                vErrors = [err72];
              } else {
                vErrors.push(err72);
              }
              errors++;
            }
            if (data27.severity === undefined) {
              const err73 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "severity" },
                message: "must have required property '" + "severity" + "'",
              };
              if (vErrors === null) {
                vErrors = [err73];
              } else {
                vErrors.push(err73);
              }
              errors++;
            }
            if (data27.state === undefined) {
              const err74 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "state" },
                message: "must have required property '" + "state" + "'",
              };
              if (vErrors === null) {
                vErrors = [err74];
              } else {
                vErrors.push(err74);
              }
              errors++;
            }
            if (data27.location === undefined) {
              const err75 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "location" },
                message: "must have required property '" + "location" + "'",
              };
              if (vErrors === null) {
                vErrors = [err75];
              } else {
                vErrors.push(err75);
              }
              errors++;
            }
            if (data27.message === undefined) {
              const err76 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "message" },
                message: "must have required property '" + "message" + "'",
              };
              if (vErrors === null) {
                vErrors = [err76];
              } else {
                vErrors.push(err76);
              }
              errors++;
            }
            if (data27.trigger === undefined) {
              const err77 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "trigger" },
                message: "must have required property '" + "trigger" + "'",
              };
              if (vErrors === null) {
                vErrors = [err77];
              } else {
                vErrors.push(err77);
              }
              errors++;
            }
            if (data27.evidence === undefined) {
              const err78 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "evidence" },
                message: "must have required property '" + "evidence" + "'",
              };
              if (vErrors === null) {
                vErrors = [err78];
              } else {
                vErrors.push(err78);
              }
              errors++;
            }
            if (data27.source === undefined) {
              const err79 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "source" },
                message: "must have required property '" + "source" + "'",
              };
              if (vErrors === null) {
                vErrors = [err79];
              } else {
                vErrors.push(err79);
              }
              errors++;
            }
            if (data27.locations === undefined) {
              const err80 = {
                instancePath: instancePath + "/findings/" + i4,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "locations" },
                message: "must have required property '" + "locations" + "'",
              };
              if (vErrors === null) {
                vErrors = [err80];
              } else {
                vErrors.push(err80);
              }
              errors++;
            }
            for (const key4 in data27) {
              if (!func1.call(schema34.properties, key4)) {
                const err81 = {
                  instancePath: instancePath + "/findings/" + i4,
                  schemaPath: "#/$defs/finding/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key4 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err81];
                } else {
                  vErrors.push(err81);
                }
                errors++;
              }
            }
            if (data27.id !== undefined) {
              let data29 = data27.id;
              if (typeof data29 === "string") {
                if (!pattern7.test(data29)) {
                  const err82 = {
                    instancePath: instancePath + "/findings/" + i4 + "/id",
                    schemaPath: "#/$defs/finding/properties/id/pattern",
                    keyword: "pattern",
                    params: { pattern: "^[a-f0-9]{64}$" },
                    message: 'must match pattern "' + "^[a-f0-9]{64}$" + '"',
                  };
                  if (vErrors === null) {
                    vErrors = [err82];
                  } else {
                    vErrors.push(err82);
                  }
                  errors++;
                }
              } else {
                const err83 = {
                  instancePath: instancePath + "/findings/" + i4 + "/id",
                  schemaPath: "#/$defs/finding/properties/id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err83];
                } else {
                  vErrors.push(err83);
                }
                errors++;
              }
            }
            if (data27.rule_id !== undefined) {
              let data30 = data27.rule_id;
              if (typeof data30 === "string") {
                if (func2(data30) < 1) {
                  const err84 = {
                    instancePath: instancePath + "/findings/" + i4 + "/rule_id",
                    schemaPath: "#/$defs/finding/properties/rule_id/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err84];
                  } else {
                    vErrors.push(err84);
                  }
                  errors++;
                }
              } else {
                const err85 = {
                  instancePath: instancePath + "/findings/" + i4 + "/rule_id",
                  schemaPath: "#/$defs/finding/properties/rule_id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err85];
                } else {
                  vErrors.push(err85);
                }
                errors++;
              }
            }
            if (data27.category !== undefined) {
              let data31 = data27.category;
              if (!(
                data31 === "defect" ||
                data31 === "risk" ||
                data31 === "security"
              )) {
                const err86 = {
                  instancePath: instancePath + "/findings/" + i4 + "/category",
                  schemaPath: "#/$defs/finding/properties/category/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.category.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err86];
                } else {
                  vErrors.push(err86);
                }
                errors++;
              }
            }
            if (data27.evidence_level !== undefined) {
              let data32 = data27.evidence_level;
              if (!(
                data32 === "reproduced" ||
                data32 === "static_proven" ||
                data32 === "plausible" ||
                data32 === "refuted"
              )) {
                const err87 = {
                  instancePath:
                    instancePath + "/findings/" + i4 + "/evidence_level",
                  schemaPath: "#/$defs/finding/properties/evidence_level/enum",
                  keyword: "enum",
                  params: {
                    allowedValues: schema34.properties.evidence_level.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err87];
                } else {
                  vErrors.push(err87);
                }
                errors++;
              }
            }
            if (data27.severity !== undefined) {
              let data33 = data27.severity;
              if (!(
                data33 === "error" ||
                data33 === "warning" ||
                data33 === "info"
              )) {
                const err88 = {
                  instancePath: instancePath + "/findings/" + i4 + "/severity",
                  schemaPath: "#/$defs/finding/properties/severity/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.severity.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err88];
                } else {
                  vErrors.push(err88);
                }
                errors++;
              }
            }
            if (data27.state !== undefined) {
              let data34 = data27.state;
              if (!(
                data34 === "new" ||
                data34 === "worsened" ||
                data34 === "pre-existing" ||
                data34 === "fixed" ||
                data34 === "unclassified"
              )) {
                const err89 = {
                  instancePath: instancePath + "/findings/" + i4 + "/state",
                  schemaPath: "#/$defs/finding/properties/state/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.state.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err89];
                } else {
                  vErrors.push(err89);
                }
                errors++;
              }
            }
            if (data27.location !== undefined) {
              let data35 = data27.location;
              if (
                data35 &&
                typeof data35 == "object" &&
                !Array.isArray(data35)
              ) {
                if (data35.path === undefined) {
                  const err90 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "path" },
                    message: "must have required property '" + "path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err90];
                  } else {
                    vErrors.push(err90);
                  }
                  errors++;
                }
                if (data35.line_start === undefined) {
                  const err91 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "line_start" },
                    message:
                      "must have required property '" + "line_start" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err91];
                  } else {
                    vErrors.push(err91);
                  }
                  errors++;
                }
                if (data35.line_end === undefined) {
                  const err92 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "line_end" },
                    message: "must have required property '" + "line_end" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err92];
                  } else {
                    vErrors.push(err92);
                  }
                  errors++;
                }
                if (data35.symbol_path === undefined) {
                  const err93 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "symbol_path" },
                    message:
                      "must have required property '" + "symbol_path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err93];
                  } else {
                    vErrors.push(err93);
                  }
                  errors++;
                }
                if (data35.occurrence_state === undefined) {
                  const err94 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "occurrence_state" },
                    message:
                      "must have required property '" +
                      "occurrence_state" +
                      "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err94];
                  } else {
                    vErrors.push(err94);
                  }
                  errors++;
                }
                for (const key5 in data35) {
                  if (!(
                    key5 === "path" ||
                    key5 === "line_start" ||
                    key5 === "line_end" ||
                    key5 === "column" ||
                    key5 === "symbol_path" ||
                    key5 === "occurrence_state"
                  )) {
                    const err95 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/location",
                      schemaPath:
                        "#/$defs/finding/properties/location/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key5 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err95];
                    } else {
                      vErrors.push(err95);
                    }
                    errors++;
                  }
                }
                if (data35.path !== undefined) {
                  let data36 = data35.path;
                  if (typeof data36 === "string") {
                    if (func2(data36) < 1) {
                      const err96 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/location/path",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/path/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err96];
                      } else {
                        vErrors.push(err96);
                      }
                      errors++;
                    }
                    if (!pattern8.test(data36)) {
                      const err97 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/location/path",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/path/pattern",
                        keyword: "pattern",
                        params: {
                          pattern:
                            "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                        },
                        message:
                          'must match pattern "' +
                          "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                          '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err97];
                      } else {
                        vErrors.push(err97);
                      }
                      errors++;
                    }
                  } else {
                    const err98 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/location/path",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err98];
                    } else {
                      vErrors.push(err98);
                    }
                    errors++;
                  }
                }
                if (data35.line_start !== undefined) {
                  let data37 = data35.line_start;
                  if (!(
                    typeof data37 == "number" &&
                    !(data37 % 1) &&
                    !isNaN(data37)
                  )) {
                    const err99 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/location/line_start",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/line_start/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err99];
                    } else {
                      vErrors.push(err99);
                    }
                    errors++;
                  }
                  if (typeof data37 == "number") {
                    if (data37 < 1 || isNaN(data37)) {
                      const err100 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i4 +
                          "/location/line_start",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/line_start/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err100];
                      } else {
                        vErrors.push(err100);
                      }
                      errors++;
                    }
                  }
                }
                if (data35.line_end !== undefined) {
                  let data38 = data35.line_end;
                  if (!(
                    typeof data38 == "number" &&
                    !(data38 % 1) &&
                    !isNaN(data38)
                  )) {
                    const err101 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/location/line_end",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/line_end/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err101];
                    } else {
                      vErrors.push(err101);
                    }
                    errors++;
                  }
                  if (typeof data38 == "number") {
                    if (data38 < 1 || isNaN(data38)) {
                      const err102 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i4 +
                          "/location/line_end",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/line_end/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err102];
                      } else {
                        vErrors.push(err102);
                      }
                      errors++;
                    }
                  }
                }
                if (data35.column !== undefined) {
                  let data39 = data35.column;
                  if (!(
                    typeof data39 == "number" &&
                    !(data39 % 1) &&
                    !isNaN(data39)
                  )) {
                    const err103 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/location/column",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/column/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err103];
                    } else {
                      vErrors.push(err103);
                    }
                    errors++;
                  }
                  if (typeof data39 == "number") {
                    if (data39 < 1 || isNaN(data39)) {
                      const err104 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/location/column",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/column/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err104];
                      } else {
                        vErrors.push(err104);
                      }
                      errors++;
                    }
                  }
                }
                if (data35.symbol_path !== undefined) {
                  if (typeof data35.symbol_path !== "string") {
                    const err105 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/location/symbol_path",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/symbol_path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err105];
                    } else {
                      vErrors.push(err105);
                    }
                    errors++;
                  }
                }
                if (data35.occurrence_state !== undefined) {
                  let data41 = data35.occurrence_state;
                  if (!(
                    data41 === "new" ||
                    data41 === "pre-existing" ||
                    data41 === "fixed" ||
                    data41 === "unclassified"
                  )) {
                    const err106 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/location/occurrence_state",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/occurrence_state/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.location.properties
                            .occurrence_state.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err106];
                    } else {
                      vErrors.push(err106);
                    }
                    errors++;
                  }
                }
              } else {
                const err107 = {
                  instancePath: instancePath + "/findings/" + i4 + "/location",
                  schemaPath: "#/$defs/finding/properties/location/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err107];
                } else {
                  vErrors.push(err107);
                }
                errors++;
              }
            }
            if (data27.message !== undefined) {
              let data42 = data27.message;
              if (typeof data42 === "string") {
                if (func2(data42) < 1) {
                  const err108 = {
                    instancePath: instancePath + "/findings/" + i4 + "/message",
                    schemaPath: "#/$defs/finding/properties/message/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err108];
                  } else {
                    vErrors.push(err108);
                  }
                  errors++;
                }
              } else {
                const err109 = {
                  instancePath: instancePath + "/findings/" + i4 + "/message",
                  schemaPath: "#/$defs/finding/properties/message/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err109];
                } else {
                  vErrors.push(err109);
                }
                errors++;
              }
            }
            if (data27.trigger !== undefined) {
              if (typeof data27.trigger !== "string") {
                const err110 = {
                  instancePath: instancePath + "/findings/" + i4 + "/trigger",
                  schemaPath: "#/$defs/finding/properties/trigger/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err110];
                } else {
                  vErrors.push(err110);
                }
                errors++;
              }
            }
            if (data27.impact !== undefined) {
              let data44 = data27.impact;
              if (typeof data44 === "string") {
                if (func2(data44) < 1) {
                  const err111 = {
                    instancePath: instancePath + "/findings/" + i4 + "/impact",
                    schemaPath: "#/$defs/finding/properties/impact/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err111];
                  } else {
                    vErrors.push(err111);
                  }
                  errors++;
                }
              } else {
                const err112 = {
                  instancePath: instancePath + "/findings/" + i4 + "/impact",
                  schemaPath: "#/$defs/finding/properties/impact/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err112];
                } else {
                  vErrors.push(err112);
                }
                errors++;
              }
            }
            if (data27.suggested_fix !== undefined) {
              let data45 = data27.suggested_fix;
              if (typeof data45 === "string") {
                if (func2(data45) < 1) {
                  const err113 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/suggested_fix",
                    schemaPath:
                      "#/$defs/finding/properties/suggested_fix/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err113];
                  } else {
                    vErrors.push(err113);
                  }
                  errors++;
                }
              } else {
                const err114 = {
                  instancePath:
                    instancePath + "/findings/" + i4 + "/suggested_fix",
                  schemaPath: "#/$defs/finding/properties/suggested_fix/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err114];
                } else {
                  vErrors.push(err114);
                }
                errors++;
              }
            }
            if (data27.evidence !== undefined) {
              let data46 = data27.evidence;
              if (Array.isArray(data46)) {
                const len5 = data46.length;
                for (let i5 = 0; i5 < len5; i5++) {
                  let data47 = data46[i5];
                  if (typeof data47 === "string") {
                    if (func2(data47) < 1) {
                      const err115 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/evidence/" + i5,
                        schemaPath:
                          "#/$defs/finding/properties/evidence/items/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err115];
                      } else {
                        vErrors.push(err115);
                      }
                      errors++;
                    }
                  } else {
                    const err116 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/evidence/" + i5,
                      schemaPath:
                        "#/$defs/finding/properties/evidence/items/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err116];
                    } else {
                      vErrors.push(err116);
                    }
                    errors++;
                  }
                }
              } else {
                const err117 = {
                  instancePath: instancePath + "/findings/" + i4 + "/evidence",
                  schemaPath: "#/$defs/finding/properties/evidence/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err117];
                } else {
                  vErrors.push(err117);
                }
                errors++;
              }
            }
            if (data27.source !== undefined) {
              let data48 = data27.source;
              const _errs105 = errors;
              let valid26 = false;
              let passing0 = null;
              const _errs106 = errors;
              if (
                data48 &&
                typeof data48 == "object" &&
                !Array.isArray(data48)
              ) {
                if (data48.tool === undefined) {
                  const err118 = {
                    instancePath: instancePath + "/findings/" + i4 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/0/required",
                    keyword: "required",
                    params: { missingProperty: "tool" },
                    message: "must have required property '" + "tool" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err118];
                  } else {
                    vErrors.push(err118);
                  }
                  errors++;
                }
                if (data48.version === undefined) {
                  const err119 = {
                    instancePath: instancePath + "/findings/" + i4 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/0/required",
                    keyword: "required",
                    params: { missingProperty: "version" },
                    message: "must have required property '" + "version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err119];
                  } else {
                    vErrors.push(err119);
                  }
                  errors++;
                }
                for (const key6 in data48) {
                  if (!(key6 === "tool" || key6 === "version")) {
                    const err120 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/source",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key6 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err120];
                    } else {
                      vErrors.push(err120);
                    }
                    errors++;
                  }
                }
                if (data48.tool !== undefined) {
                  let data49 = data48.tool;
                  if (typeof data49 === "string") {
                    if (func2(data49) < 1) {
                      const err121 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/source/tool",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/0/properties/tool/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err121];
                      } else {
                        vErrors.push(err121);
                      }
                      errors++;
                    }
                  } else {
                    const err122 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/source/tool",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/properties/tool/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err122];
                    } else {
                      vErrors.push(err122);
                    }
                    errors++;
                  }
                }
                if (data48.version !== undefined) {
                  let data50 = data48.version;
                  if (typeof data50 === "string") {
                    if (func2(data50) < 1) {
                      const err123 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/source/version",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/0/properties/version/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err123];
                      } else {
                        vErrors.push(err123);
                      }
                      errors++;
                    }
                  } else {
                    const err124 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/source/version",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/properties/version/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err124];
                    } else {
                      vErrors.push(err124);
                    }
                    errors++;
                  }
                }
              } else {
                const err125 = {
                  instancePath: instancePath + "/findings/" + i4 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf/0/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err125];
                } else {
                  vErrors.push(err125);
                }
                errors++;
              }
              var _valid2 = _errs106 === errors;
              if (_valid2) {
                valid26 = true;
                passing0 = 0;
                var props0 = true;
              }
              const _errs113 = errors;
              if (
                data48 &&
                typeof data48 == "object" &&
                !Array.isArray(data48)
              ) {
                if (data48.agent === undefined) {
                  const err126 = {
                    instancePath: instancePath + "/findings/" + i4 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/1/required",
                    keyword: "required",
                    params: { missingProperty: "agent" },
                    message: "must have required property '" + "agent" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err126];
                  } else {
                    vErrors.push(err126);
                  }
                  errors++;
                }
                for (const key7 in data48) {
                  if (!(key7 === "agent")) {
                    const err127 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/source",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/1/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key7 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err127];
                    } else {
                      vErrors.push(err127);
                    }
                    errors++;
                  }
                }
                if (data48.agent !== undefined) {
                  let data51 = data48.agent;
                  if (typeof data51 === "string") {
                    if (func2(data51) < 1) {
                      const err128 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/source/agent",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/1/properties/agent/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err128];
                      } else {
                        vErrors.push(err128);
                      }
                      errors++;
                    }
                  } else {
                    const err129 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/source/agent",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/1/properties/agent/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err129];
                    } else {
                      vErrors.push(err129);
                    }
                    errors++;
                  }
                }
              } else {
                const err130 = {
                  instancePath: instancePath + "/findings/" + i4 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf/1/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err130];
                } else {
                  vErrors.push(err130);
                }
                errors++;
              }
              var _valid2 = _errs113 === errors;
              if (_valid2 && valid26) {
                valid26 = false;
                passing0 = [passing0, 1];
              } else {
                if (_valid2) {
                  valid26 = true;
                  passing0 = 1;
                  if (props0 !== true) {
                    props0 = true;
                  }
                }
              }
              if (!valid26) {
                const err131 = {
                  instancePath: instancePath + "/findings/" + i4 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf",
                  keyword: "oneOf",
                  params: { passingSchemas: passing0 },
                  message: "must match exactly one schema in oneOf",
                };
                if (vErrors === null) {
                  vErrors = [err131];
                } else {
                  vErrors.push(err131);
                }
                errors++;
              } else {
                errors = _errs105;
                if (vErrors !== null) {
                  if (_errs105) {
                    vErrors.length = _errs105;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
            if (data27.locations !== undefined) {
              let data52 = data27.locations;
              if (Array.isArray(data52)) {
                if (data52.length < 1) {
                  const err132 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/locations",
                    schemaPath: "#/$defs/finding/properties/locations/minItems",
                    keyword: "minItems",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 items",
                  };
                  if (vErrors === null) {
                    vErrors = [err132];
                  } else {
                    vErrors.push(err132);
                  }
                  errors++;
                }
                const len6 = data52.length;
                for (let i6 = 0; i6 < len6; i6++) {
                  let data53 = data52[i6];
                  if (
                    data53 &&
                    typeof data53 == "object" &&
                    !Array.isArray(data53)
                  ) {
                    if (data53.path === undefined) {
                      const err133 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/locations/" + i6,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "path" },
                        message: "must have required property '" + "path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err133];
                      } else {
                        vErrors.push(err133);
                      }
                      errors++;
                    }
                    if (data53.line_start === undefined) {
                      const err134 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/locations/" + i6,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_start" },
                        message:
                          "must have required property '" + "line_start" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err134];
                      } else {
                        vErrors.push(err134);
                      }
                      errors++;
                    }
                    if (data53.line_end === undefined) {
                      const err135 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/locations/" + i6,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_end" },
                        message:
                          "must have required property '" + "line_end" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err135];
                      } else {
                        vErrors.push(err135);
                      }
                      errors++;
                    }
                    if (data53.symbol_path === undefined) {
                      const err136 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/locations/" + i6,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "symbol_path" },
                        message:
                          "must have required property '" + "symbol_path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err136];
                      } else {
                        vErrors.push(err136);
                      }
                      errors++;
                    }
                    if (data53.occurrence_state === undefined) {
                      const err137 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/locations/" + i6,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "occurrence_state" },
                        message:
                          "must have required property '" +
                          "occurrence_state" +
                          "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err137];
                      } else {
                        vErrors.push(err137);
                      }
                      errors++;
                    }
                    for (const key8 in data53) {
                      if (!(
                        key8 === "path" ||
                        key8 === "line_start" ||
                        key8 === "line_end" ||
                        key8 === "column" ||
                        key8 === "symbol_path" ||
                        key8 === "occurrence_state" ||
                        key8 === "id"
                      )) {
                        const err138 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/locations/" +
                            i6,
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/additionalProperties",
                          keyword: "additionalProperties",
                          params: { additionalProperty: key8 },
                          message: "must NOT have additional properties",
                        };
                        if (vErrors === null) {
                          vErrors = [err138];
                        } else {
                          vErrors.push(err138);
                        }
                        errors++;
                      }
                    }
                    if (data53.path !== undefined) {
                      let data54 = data53.path;
                      if (typeof data54 === "string") {
                        if (func2(data54) < 1) {
                          const err139 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i4 +
                              "/locations/" +
                              i6 +
                              "/path",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/path/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err139];
                          } else {
                            vErrors.push(err139);
                          }
                          errors++;
                        }
                        if (!pattern8.test(data54)) {
                          const err140 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i4 +
                              "/locations/" +
                              i6 +
                              "/path",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/path/pattern",
                            keyword: "pattern",
                            params: {
                              pattern:
                                "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                            },
                            message:
                              'must match pattern "' +
                              "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                              '"',
                          };
                          if (vErrors === null) {
                            vErrors = [err140];
                          } else {
                            vErrors.push(err140);
                          }
                          errors++;
                        }
                      } else {
                        const err141 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/locations/" +
                            i6 +
                            "/path",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err141];
                        } else {
                          vErrors.push(err141);
                        }
                        errors++;
                      }
                    }
                    if (data53.line_start !== undefined) {
                      let data55 = data53.line_start;
                      if (!(
                        typeof data55 == "number" &&
                        !(data55 % 1) &&
                        !isNaN(data55)
                      )) {
                        const err142 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/locations/" +
                            i6 +
                            "/line_start",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/line_start/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err142];
                        } else {
                          vErrors.push(err142);
                        }
                        errors++;
                      }
                      if (typeof data55 == "number") {
                        if (data55 < 1 || isNaN(data55)) {
                          const err143 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i4 +
                              "/locations/" +
                              i6 +
                              "/line_start",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/line_start/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err143];
                          } else {
                            vErrors.push(err143);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data53.line_end !== undefined) {
                      let data56 = data53.line_end;
                      if (!(
                        typeof data56 == "number" &&
                        !(data56 % 1) &&
                        !isNaN(data56)
                      )) {
                        const err144 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/locations/" +
                            i6 +
                            "/line_end",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/line_end/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err144];
                        } else {
                          vErrors.push(err144);
                        }
                        errors++;
                      }
                      if (typeof data56 == "number") {
                        if (data56 < 1 || isNaN(data56)) {
                          const err145 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i4 +
                              "/locations/" +
                              i6 +
                              "/line_end",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/line_end/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err145];
                          } else {
                            vErrors.push(err145);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data53.column !== undefined) {
                      let data57 = data53.column;
                      if (!(
                        typeof data57 == "number" &&
                        !(data57 % 1) &&
                        !isNaN(data57)
                      )) {
                        const err146 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/locations/" +
                            i6 +
                            "/column",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/column/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err146];
                        } else {
                          vErrors.push(err146);
                        }
                        errors++;
                      }
                      if (typeof data57 == "number") {
                        if (data57 < 1 || isNaN(data57)) {
                          const err147 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i4 +
                              "/locations/" +
                              i6 +
                              "/column",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/column/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err147];
                          } else {
                            vErrors.push(err147);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data53.symbol_path !== undefined) {
                      if (typeof data53.symbol_path !== "string") {
                        const err148 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/locations/" +
                            i6 +
                            "/symbol_path",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/symbol_path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err148];
                        } else {
                          vErrors.push(err148);
                        }
                        errors++;
                      }
                    }
                    if (data53.occurrence_state !== undefined) {
                      let data59 = data53.occurrence_state;
                      if (!(
                        data59 === "new" ||
                        data59 === "pre-existing" ||
                        data59 === "fixed" ||
                        data59 === "unclassified"
                      )) {
                        const err149 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/locations/" +
                            i6 +
                            "/occurrence_state",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/occurrence_state/enum",
                          keyword: "enum",
                          params: {
                            allowedValues:
                              schema34.properties.locations.items.properties
                                .occurrence_state.enum,
                          },
                          message: "must be equal to one of the allowed values",
                        };
                        if (vErrors === null) {
                          vErrors = [err149];
                        } else {
                          vErrors.push(err149);
                        }
                        errors++;
                      }
                    }
                    if (data53.id !== undefined) {
                      let data60 = data53.id;
                      if (typeof data60 === "string") {
                        if (func2(data60) < 1) {
                          const err150 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i4 +
                              "/locations/" +
                              i6 +
                              "/id",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/id/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err150];
                          } else {
                            vErrors.push(err150);
                          }
                          errors++;
                        }
                      } else {
                        const err151 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/locations/" +
                            i6 +
                            "/id",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/id/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err151];
                        } else {
                          vErrors.push(err151);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err152 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/locations/" + i6,
                      schemaPath:
                        "#/$defs/finding/properties/locations/items/type",
                      keyword: "type",
                      params: { type: "object" },
                      message: "must be object",
                    };
                    if (vErrors === null) {
                      vErrors = [err152];
                    } else {
                      vErrors.push(err152);
                    }
                    errors++;
                  }
                }
              } else {
                const err153 = {
                  instancePath: instancePath + "/findings/" + i4 + "/locations",
                  schemaPath: "#/$defs/finding/properties/locations/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err153];
                } else {
                  vErrors.push(err153);
                }
                errors++;
              }
            }
            if (data27.advisory !== undefined) {
              let data61 = data27.advisory;
              if (
                data61 &&
                typeof data61 == "object" &&
                !Array.isArray(data61)
              ) {
                if (data61.id === undefined) {
                  const err154 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "id" },
                    message: "must have required property '" + "id" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err154];
                  } else {
                    vErrors.push(err154);
                  }
                  errors++;
                }
                if (data61.aliases === undefined) {
                  const err155 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "aliases" },
                    message: "must have required property '" + "aliases" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err155];
                  } else {
                    vErrors.push(err155);
                  }
                  errors++;
                }
                if (data61.severity === undefined) {
                  const err156 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "severity" },
                    message: "must have required property '" + "severity" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err156];
                  } else {
                    vErrors.push(err156);
                  }
                  errors++;
                }
                if (data61.fixed_version === undefined) {
                  const err157 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "fixed_version" },
                    message:
                      "must have required property '" + "fixed_version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err157];
                  } else {
                    vErrors.push(err157);
                  }
                  errors++;
                }
                if (data61.url === undefined) {
                  const err158 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "url" },
                    message: "must have required property '" + "url" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err158];
                  } else {
                    vErrors.push(err158);
                  }
                  errors++;
                }
                for (const key9 in data61) {
                  if (!(
                    key9 === "id" ||
                    key9 === "aliases" ||
                    key9 === "severity" ||
                    key9 === "fixed_version" ||
                    key9 === "url"
                  )) {
                    const err159 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/advisory",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key9 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err159];
                    } else {
                      vErrors.push(err159);
                    }
                    errors++;
                  }
                }
                if (data61.id !== undefined) {
                  let data62 = data61.id;
                  if (typeof data62 === "string") {
                    if (func2(data62) < 1) {
                      const err160 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/advisory/id",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/id/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err160];
                      } else {
                        vErrors.push(err160);
                      }
                      errors++;
                    }
                  } else {
                    const err161 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/advisory/id",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/id/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err161];
                    } else {
                      vErrors.push(err161);
                    }
                    errors++;
                  }
                }
                if (data61.aliases !== undefined) {
                  let data63 = data61.aliases;
                  if (Array.isArray(data63)) {
                    const len7 = data63.length;
                    for (let i7 = 0; i7 < len7; i7++) {
                      let data64 = data63[i7];
                      if (typeof data64 === "string") {
                        if (func2(data64) < 1) {
                          const err162 = {
                            instancePath:
                              instancePath +
                              "/findings/" +
                              i4 +
                              "/advisory/aliases/" +
                              i7,
                            schemaPath:
                              "#/$defs/finding/properties/advisory/properties/aliases/items/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err162];
                          } else {
                            vErrors.push(err162);
                          }
                          errors++;
                        }
                      } else {
                        const err163 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/advisory/aliases/" +
                            i7,
                          schemaPath:
                            "#/$defs/finding/properties/advisory/properties/aliases/items/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err163];
                        } else {
                          vErrors.push(err163);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err164 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/advisory/aliases",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/aliases/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err164];
                    } else {
                      vErrors.push(err164);
                    }
                    errors++;
                  }
                }
                if (data61.severity !== undefined) {
                  let data65 = data61.severity;
                  if (!(
                    data65 === "critical" ||
                    data65 === "high" ||
                    data65 === "moderate" ||
                    data65 === "low" ||
                    data65 === "unknown"
                  )) {
                    const err165 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/advisory/severity",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/severity/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.advisory.properties.severity.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err165];
                    } else {
                      vErrors.push(err165);
                    }
                    errors++;
                  }
                }
                if (data61.fixed_version !== undefined) {
                  let data66 = data61.fixed_version;
                  if (typeof data66 === "string") {
                    if (func2(data66) < 1) {
                      const err166 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i4 +
                          "/advisory/fixed_version",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/fixed_version/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err166];
                      } else {
                        vErrors.push(err166);
                      }
                      errors++;
                    }
                  } else {
                    const err167 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/advisory/fixed_version",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/fixed_version/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err167];
                    } else {
                      vErrors.push(err167);
                    }
                    errors++;
                  }
                }
                if (data61.url !== undefined) {
                  let data67 = data61.url;
                  if (typeof data67 === "string") {
                    if (!pattern10.test(data67)) {
                      const err168 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/advisory/url",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/url/pattern",
                        keyword: "pattern",
                        params: { pattern: "^https://" },
                        message: 'must match pattern "' + "^https://" + '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err168];
                      } else {
                        vErrors.push(err168);
                      }
                      errors++;
                    }
                  } else {
                    const err169 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/advisory/url",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/url/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err169];
                    } else {
                      vErrors.push(err169);
                    }
                    errors++;
                  }
                }
              } else {
                const err170 = {
                  instancePath: instancePath + "/findings/" + i4 + "/advisory",
                  schemaPath: "#/$defs/finding/properties/advisory/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err170];
                } else {
                  vErrors.push(err170);
                }
                errors++;
              }
            }
            if (data27.round !== undefined) {
              let data68 = data27.round;
              if (!(
                typeof data68 == "number" &&
                !(data68 % 1) &&
                !isNaN(data68)
              )) {
                const err171 = {
                  instancePath: instancePath + "/findings/" + i4 + "/round",
                  schemaPath: "#/$defs/finding/properties/round/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err171];
                } else {
                  vErrors.push(err171);
                }
                errors++;
              }
              if (typeof data68 == "number") {
                if (data68 < 1 || isNaN(data68)) {
                  const err172 = {
                    instancePath: instancePath + "/findings/" + i4 + "/round",
                    schemaPath: "#/$defs/finding/properties/round/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err172];
                  } else {
                    vErrors.push(err172);
                  }
                  errors++;
                }
              }
            }
            if (data27.first_posted_in !== undefined) {
              let data69 = data27.first_posted_in;
              if (typeof data69 === "string") {
                if (func2(data69) < 1) {
                  const err173 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/first_posted_in",
                    schemaPath:
                      "#/$defs/finding/properties/first_posted_in/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err173];
                  } else {
                    vErrors.push(err173);
                  }
                  errors++;
                }
              } else {
                const err174 = {
                  instancePath:
                    instancePath + "/findings/" + i4 + "/first_posted_in",
                  schemaPath: "#/$defs/finding/properties/first_posted_in/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err174];
                } else {
                  vErrors.push(err174);
                }
                errors++;
              }
            }
            if (data27.author_response !== undefined) {
              let data70 = data27.author_response;
              if (
                data70 &&
                typeof data70 == "object" &&
                !Array.isArray(data70)
              ) {
                if (data70.reason === undefined) {
                  const err175 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "reason" },
                    message: "must have required property '" + "reason" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err175];
                  } else {
                    vErrors.push(err175);
                  }
                  errors++;
                }
                if (data70.actor === undefined) {
                  const err176 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "actor" },
                    message: "must have required property '" + "actor" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err176];
                  } else {
                    vErrors.push(err176);
                  }
                  errors++;
                }
                if (data70.at === undefined) {
                  const err177 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "at" },
                    message: "must have required property '" + "at" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err177];
                  } else {
                    vErrors.push(err177);
                  }
                  errors++;
                }
                for (const key10 in data70) {
                  if (!(
                    key10 === "reason" ||
                    key10 === "actor" ||
                    key10 === "at" ||
                    key10 === "note"
                  )) {
                    const err178 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/author_response",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key10 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err178];
                    } else {
                      vErrors.push(err178);
                    }
                    errors++;
                  }
                }
                if (data70.reason !== undefined) {
                  let data71 = data70.reason;
                  if (!(
                    data71 === "fixed" ||
                    data71 === "wrong" ||
                    data71 === "intentional" ||
                    data71 === "irrelevant" ||
                    data71 === "style"
                  )) {
                    const err179 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/author_response/reason",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/reason/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.author_response.properties.reason
                            .enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err179];
                    } else {
                      vErrors.push(err179);
                    }
                    errors++;
                  }
                }
                if (data70.actor !== undefined) {
                  let data72 = data70.actor;
                  if (typeof data72 === "string") {
                    if (func2(data72) < 1) {
                      const err180 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i4 +
                          "/author_response/actor",
                        schemaPath:
                          "#/$defs/finding/properties/author_response/properties/actor/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err180];
                      } else {
                        vErrors.push(err180);
                      }
                      errors++;
                    }
                  } else {
                    const err181 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/author_response/actor",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/actor/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err181];
                    } else {
                      vErrors.push(err181);
                    }
                    errors++;
                  }
                }
                if (data70.at !== undefined) {
                  let data73 = data70.at;
                  if (typeof data73 === "string") {
                    if (!formats0.validate(data73)) {
                      const err182 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i4 +
                          "/author_response/at",
                        schemaPath:
                          "#/$defs/finding/properties/author_response/properties/at/format",
                        keyword: "format",
                        params: { format: "date-time" },
                        message: 'must match format "' + "date-time" + '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err182];
                      } else {
                        vErrors.push(err182);
                      }
                      errors++;
                    }
                  } else {
                    const err183 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/author_response/at",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/at/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err183];
                    } else {
                      vErrors.push(err183);
                    }
                    errors++;
                  }
                }
                if (data70.note !== undefined) {
                  if (typeof data70.note !== "string") {
                    const err184 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/author_response/note",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/note/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err184];
                    } else {
                      vErrors.push(err184);
                    }
                    errors++;
                  }
                }
              } else {
                const err185 = {
                  instancePath:
                    instancePath + "/findings/" + i4 + "/author_response",
                  schemaPath: "#/$defs/finding/properties/author_response/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err185];
                } else {
                  vErrors.push(err185);
                }
                errors++;
              }
            }
            if (data27.status !== undefined) {
              let data75 = data27.status;
              if (!(
                data75 === "open" ||
                data75 === "fixed" ||
                data75 === "dismissed"
              )) {
                const err186 = {
                  instancePath: instancePath + "/findings/" + i4 + "/status",
                  schemaPath: "#/$defs/finding/properties/status/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.status.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err186];
                } else {
                  vErrors.push(err186);
                }
                errors++;
              }
            }
            if (data27.resolution !== undefined) {
              let data76 = data27.resolution;
              if (
                data76 &&
                typeof data76 == "object" &&
                !Array.isArray(data76)
              ) {
                for (const key11 in data76) {
                  if (!(key11 === "fixed_in" || key11 === "note")) {
                    const err187 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/resolution",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key11 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err187];
                    } else {
                      vErrors.push(err187);
                    }
                    errors++;
                  }
                }
                if (data76.fixed_in !== undefined) {
                  let data77 = data76.fixed_in;
                  if (typeof data77 === "string") {
                    if (func2(data77) < 1) {
                      const err188 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i4 +
                          "/resolution/fixed_in",
                        schemaPath:
                          "#/$defs/finding/properties/resolution/properties/fixed_in/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err188];
                      } else {
                        vErrors.push(err188);
                      }
                      errors++;
                    }
                  } else {
                    const err189 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/resolution/fixed_in",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/properties/fixed_in/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err189];
                    } else {
                      vErrors.push(err189);
                    }
                    errors++;
                  }
                }
                if (data76.note !== undefined) {
                  let data78 = data76.note;
                  if (typeof data78 === "string") {
                    if (func2(data78) < 1) {
                      const err190 = {
                        instancePath:
                          instancePath + "/findings/" + i4 + "/resolution/note",
                        schemaPath:
                          "#/$defs/finding/properties/resolution/properties/note/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err190];
                      } else {
                        vErrors.push(err190);
                      }
                      errors++;
                    }
                  } else {
                    const err191 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/resolution/note",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/properties/note/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err191];
                    } else {
                      vErrors.push(err191);
                    }
                    errors++;
                  }
                }
              } else {
                const err192 = {
                  instancePath:
                    instancePath + "/findings/" + i4 + "/resolution",
                  schemaPath: "#/$defs/finding/properties/resolution/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err192];
                } else {
                  vErrors.push(err192);
                }
                errors++;
              }
            }
            if (data27.verification !== undefined) {
              let data79 = data27.verification;
              if (
                data79 &&
                typeof data79 == "object" &&
                !Array.isArray(data79)
              ) {
                if (data79.voters === undefined) {
                  const err193 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "voters" },
                    message: "must have required property '" + "voters" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err193];
                  } else {
                    vErrors.push(err193);
                  }
                  errors++;
                }
                if (data79.agreeing === undefined) {
                  const err194 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "agreeing" },
                    message: "must have required property '" + "agreeing" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err194];
                  } else {
                    vErrors.push(err194);
                  }
                  errors++;
                }
                if (data79.blind_match === undefined) {
                  const err195 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "blind_match" },
                    message:
                      "must have required property '" + "blind_match" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err195];
                  } else {
                    vErrors.push(err195);
                  }
                  errors++;
                }
                if (data79.split === undefined) {
                  const err196 = {
                    instancePath:
                      instancePath + "/findings/" + i4 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "split" },
                    message: "must have required property '" + "split" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err196];
                  } else {
                    vErrors.push(err196);
                  }
                  errors++;
                }
                for (const key12 in data79) {
                  if (!(
                    key12 === "voters" ||
                    key12 === "agreeing" ||
                    key12 === "blind_match" ||
                    key12 === "split"
                  )) {
                    const err197 = {
                      instancePath:
                        instancePath + "/findings/" + i4 + "/verification",
                      schemaPath:
                        "#/$defs/finding/properties/verification/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key12 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err197];
                    } else {
                      vErrors.push(err197);
                    }
                    errors++;
                  }
                }
                if (data79.voters !== undefined) {
                  let data80 = data79.voters;
                  if (!(
                    typeof data80 == "number" &&
                    !(data80 % 1) &&
                    !isNaN(data80)
                  )) {
                    const err198 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/verification/voters",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/voters/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err198];
                    } else {
                      vErrors.push(err198);
                    }
                    errors++;
                  }
                  if (typeof data80 == "number") {
                    if (data80 < 1 || isNaN(data80)) {
                      const err199 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i4 +
                          "/verification/voters",
                        schemaPath:
                          "#/$defs/finding/properties/verification/properties/voters/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err199];
                      } else {
                        vErrors.push(err199);
                      }
                      errors++;
                    }
                  }
                }
                if (data79.agreeing !== undefined) {
                  let data81 = data79.agreeing;
                  if (!(
                    typeof data81 == "number" &&
                    !(data81 % 1) &&
                    !isNaN(data81)
                  )) {
                    const err200 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/verification/agreeing",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/agreeing/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err200];
                    } else {
                      vErrors.push(err200);
                    }
                    errors++;
                  }
                  if (typeof data81 == "number") {
                    if (data81 < 0 || isNaN(data81)) {
                      const err201 = {
                        instancePath:
                          instancePath +
                          "/findings/" +
                          i4 +
                          "/verification/agreeing",
                        schemaPath:
                          "#/$defs/finding/properties/verification/properties/agreeing/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 0 },
                        message: "must be >= 0",
                      };
                      if (vErrors === null) {
                        vErrors = [err201];
                      } else {
                        vErrors.push(err201);
                      }
                      errors++;
                    }
                  }
                }
                if (data79.blind_match !== undefined) {
                  let data82 = data79.blind_match;
                  if (Array.isArray(data82)) {
                    const len8 = data82.length;
                    for (let i8 = 0; i8 < len8; i8++) {
                      let data83 = data82[i8];
                      if (!(
                        data83 === "same" ||
                        data83 === "related" ||
                        data83 === "none"
                      )) {
                        const err202 = {
                          instancePath:
                            instancePath +
                            "/findings/" +
                            i4 +
                            "/verification/blind_match/" +
                            i8,
                          schemaPath:
                            "#/$defs/finding/properties/verification/properties/blind_match/items/enum",
                          keyword: "enum",
                          params: {
                            allowedValues:
                              schema34.properties.verification.properties
                                .blind_match.items.enum,
                          },
                          message: "must be equal to one of the allowed values",
                        };
                        if (vErrors === null) {
                          vErrors = [err202];
                        } else {
                          vErrors.push(err202);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err203 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/verification/blind_match",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/blind_match/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err203];
                    } else {
                      vErrors.push(err203);
                    }
                    errors++;
                  }
                }
                if (data79.split !== undefined) {
                  if (typeof data79.split !== "boolean") {
                    const err204 = {
                      instancePath:
                        instancePath +
                        "/findings/" +
                        i4 +
                        "/verification/split",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/split/type",
                      keyword: "type",
                      params: { type: "boolean" },
                      message: "must be boolean",
                    };
                    if (vErrors === null) {
                      vErrors = [err204];
                    } else {
                      vErrors.push(err204);
                    }
                    errors++;
                  }
                }
              } else {
                const err205 = {
                  instancePath:
                    instancePath + "/findings/" + i4 + "/verification",
                  schemaPath: "#/$defs/finding/properties/verification/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err205];
                } else {
                  vErrors.push(err205);
                }
                errors++;
              }
            }
          } else {
            const err206 = {
              instancePath: instancePath + "/findings/" + i4,
              schemaPath: "#/$defs/finding/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err206];
            } else {
              vErrors.push(err206);
            }
            errors++;
          }
        }
      } else {
        const err207 = {
          instancePath: instancePath + "/findings",
          schemaPath: "#/properties/findings/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err207];
        } else {
          vErrors.push(err207);
        }
        errors++;
      }
    }
    if (data.risks !== undefined) {
      let data85 = data.risks;
      if (Array.isArray(data85)) {
        const len9 = data85.length;
        for (let i9 = 0; i9 < len9; i9++) {
          let data86 = data85[i9];
          const _errs190 = errors;
          let valid44 = true;
          const _errs191 = errors;
          if (data86 && typeof data86 == "object" && !Array.isArray(data86)) {
            if (data86.rule_id !== undefined) {
              let data87 = data86.rule_id;
              if (typeof data87 === "string") {
                if (!pattern6.test(data87)) {
                  const err208 = {};
                  if (vErrors === null) {
                    vErrors = [err208];
                  } else {
                    vErrors.push(err208);
                  }
                  errors++;
                }
              }
            }
          }
          var _valid3 = _errs191 === errors;
          errors = _errs190;
          if (vErrors !== null) {
            if (_errs190) {
              vErrors.length = _errs190;
            } else {
              vErrors = null;
            }
          }
          if (_valid3) {
            const _errs193 = errors;
            if (data86 && typeof data86 == "object" && !Array.isArray(data86)) {
              if (data86.advisory === undefined) {
                const err209 = {
                  instancePath: instancePath + "/risks/" + i9,
                  schemaPath: "#/$defs/finding/allOf/0/then/required",
                  keyword: "required",
                  params: { missingProperty: "advisory" },
                  message: "must have required property '" + "advisory" + "'",
                };
                if (vErrors === null) {
                  vErrors = [err209];
                } else {
                  vErrors.push(err209);
                }
                errors++;
              }
            }
            var _valid3 = _errs193 === errors;
            valid44 = _valid3;
          }
          if (!valid44) {
            const err210 = {
              instancePath: instancePath + "/risks/" + i9,
              schemaPath: "#/$defs/finding/allOf/0/if",
              keyword: "if",
              params: { failingKeyword: "then" },
              message: 'must match "then" schema',
            };
            if (vErrors === null) {
              vErrors = [err210];
            } else {
              vErrors.push(err210);
            }
            errors++;
          }
          if (data86 && typeof data86 == "object" && !Array.isArray(data86)) {
            if (data86.id === undefined) {
              const err211 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "id" },
                message: "must have required property '" + "id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err211];
              } else {
                vErrors.push(err211);
              }
              errors++;
            }
            if (data86.rule_id === undefined) {
              const err212 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "rule_id" },
                message: "must have required property '" + "rule_id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err212];
              } else {
                vErrors.push(err212);
              }
              errors++;
            }
            if (data86.category === undefined) {
              const err213 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "category" },
                message: "must have required property '" + "category" + "'",
              };
              if (vErrors === null) {
                vErrors = [err213];
              } else {
                vErrors.push(err213);
              }
              errors++;
            }
            if (data86.evidence_level === undefined) {
              const err214 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "evidence_level" },
                message:
                  "must have required property '" + "evidence_level" + "'",
              };
              if (vErrors === null) {
                vErrors = [err214];
              } else {
                vErrors.push(err214);
              }
              errors++;
            }
            if (data86.severity === undefined) {
              const err215 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "severity" },
                message: "must have required property '" + "severity" + "'",
              };
              if (vErrors === null) {
                vErrors = [err215];
              } else {
                vErrors.push(err215);
              }
              errors++;
            }
            if (data86.state === undefined) {
              const err216 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "state" },
                message: "must have required property '" + "state" + "'",
              };
              if (vErrors === null) {
                vErrors = [err216];
              } else {
                vErrors.push(err216);
              }
              errors++;
            }
            if (data86.location === undefined) {
              const err217 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "location" },
                message: "must have required property '" + "location" + "'",
              };
              if (vErrors === null) {
                vErrors = [err217];
              } else {
                vErrors.push(err217);
              }
              errors++;
            }
            if (data86.message === undefined) {
              const err218 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "message" },
                message: "must have required property '" + "message" + "'",
              };
              if (vErrors === null) {
                vErrors = [err218];
              } else {
                vErrors.push(err218);
              }
              errors++;
            }
            if (data86.trigger === undefined) {
              const err219 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "trigger" },
                message: "must have required property '" + "trigger" + "'",
              };
              if (vErrors === null) {
                vErrors = [err219];
              } else {
                vErrors.push(err219);
              }
              errors++;
            }
            if (data86.evidence === undefined) {
              const err220 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "evidence" },
                message: "must have required property '" + "evidence" + "'",
              };
              if (vErrors === null) {
                vErrors = [err220];
              } else {
                vErrors.push(err220);
              }
              errors++;
            }
            if (data86.source === undefined) {
              const err221 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "source" },
                message: "must have required property '" + "source" + "'",
              };
              if (vErrors === null) {
                vErrors = [err221];
              } else {
                vErrors.push(err221);
              }
              errors++;
            }
            if (data86.locations === undefined) {
              const err222 = {
                instancePath: instancePath + "/risks/" + i9,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "locations" },
                message: "must have required property '" + "locations" + "'",
              };
              if (vErrors === null) {
                vErrors = [err222];
              } else {
                vErrors.push(err222);
              }
              errors++;
            }
            for (const key13 in data86) {
              if (!func1.call(schema34.properties, key13)) {
                const err223 = {
                  instancePath: instancePath + "/risks/" + i9,
                  schemaPath: "#/$defs/finding/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key13 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err223];
                } else {
                  vErrors.push(err223);
                }
                errors++;
              }
            }
            if (data86.id !== undefined) {
              let data88 = data86.id;
              if (typeof data88 === "string") {
                if (!pattern7.test(data88)) {
                  const err224 = {
                    instancePath: instancePath + "/risks/" + i9 + "/id",
                    schemaPath: "#/$defs/finding/properties/id/pattern",
                    keyword: "pattern",
                    params: { pattern: "^[a-f0-9]{64}$" },
                    message: 'must match pattern "' + "^[a-f0-9]{64}$" + '"',
                  };
                  if (vErrors === null) {
                    vErrors = [err224];
                  } else {
                    vErrors.push(err224);
                  }
                  errors++;
                }
              } else {
                const err225 = {
                  instancePath: instancePath + "/risks/" + i9 + "/id",
                  schemaPath: "#/$defs/finding/properties/id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err225];
                } else {
                  vErrors.push(err225);
                }
                errors++;
              }
            }
            if (data86.rule_id !== undefined) {
              let data89 = data86.rule_id;
              if (typeof data89 === "string") {
                if (func2(data89) < 1) {
                  const err226 = {
                    instancePath: instancePath + "/risks/" + i9 + "/rule_id",
                    schemaPath: "#/$defs/finding/properties/rule_id/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err226];
                  } else {
                    vErrors.push(err226);
                  }
                  errors++;
                }
              } else {
                const err227 = {
                  instancePath: instancePath + "/risks/" + i9 + "/rule_id",
                  schemaPath: "#/$defs/finding/properties/rule_id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err227];
                } else {
                  vErrors.push(err227);
                }
                errors++;
              }
            }
            if (data86.category !== undefined) {
              let data90 = data86.category;
              if (!(
                data90 === "defect" ||
                data90 === "risk" ||
                data90 === "security"
              )) {
                const err228 = {
                  instancePath: instancePath + "/risks/" + i9 + "/category",
                  schemaPath: "#/$defs/finding/properties/category/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.category.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err228];
                } else {
                  vErrors.push(err228);
                }
                errors++;
              }
            }
            if (data86.evidence_level !== undefined) {
              let data91 = data86.evidence_level;
              if (!(
                data91 === "reproduced" ||
                data91 === "static_proven" ||
                data91 === "plausible" ||
                data91 === "refuted"
              )) {
                const err229 = {
                  instancePath:
                    instancePath + "/risks/" + i9 + "/evidence_level",
                  schemaPath: "#/$defs/finding/properties/evidence_level/enum",
                  keyword: "enum",
                  params: {
                    allowedValues: schema34.properties.evidence_level.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err229];
                } else {
                  vErrors.push(err229);
                }
                errors++;
              }
            }
            if (data86.severity !== undefined) {
              let data92 = data86.severity;
              if (!(
                data92 === "error" ||
                data92 === "warning" ||
                data92 === "info"
              )) {
                const err230 = {
                  instancePath: instancePath + "/risks/" + i9 + "/severity",
                  schemaPath: "#/$defs/finding/properties/severity/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.severity.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err230];
                } else {
                  vErrors.push(err230);
                }
                errors++;
              }
            }
            if (data86.state !== undefined) {
              let data93 = data86.state;
              if (!(
                data93 === "new" ||
                data93 === "worsened" ||
                data93 === "pre-existing" ||
                data93 === "fixed" ||
                data93 === "unclassified"
              )) {
                const err231 = {
                  instancePath: instancePath + "/risks/" + i9 + "/state",
                  schemaPath: "#/$defs/finding/properties/state/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.state.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err231];
                } else {
                  vErrors.push(err231);
                }
                errors++;
              }
            }
            if (data86.location !== undefined) {
              let data94 = data86.location;
              if (
                data94 &&
                typeof data94 == "object" &&
                !Array.isArray(data94)
              ) {
                if (data94.path === undefined) {
                  const err232 = {
                    instancePath: instancePath + "/risks/" + i9 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "path" },
                    message: "must have required property '" + "path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err232];
                  } else {
                    vErrors.push(err232);
                  }
                  errors++;
                }
                if (data94.line_start === undefined) {
                  const err233 = {
                    instancePath: instancePath + "/risks/" + i9 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "line_start" },
                    message:
                      "must have required property '" + "line_start" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err233];
                  } else {
                    vErrors.push(err233);
                  }
                  errors++;
                }
                if (data94.line_end === undefined) {
                  const err234 = {
                    instancePath: instancePath + "/risks/" + i9 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "line_end" },
                    message: "must have required property '" + "line_end" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err234];
                  } else {
                    vErrors.push(err234);
                  }
                  errors++;
                }
                if (data94.symbol_path === undefined) {
                  const err235 = {
                    instancePath: instancePath + "/risks/" + i9 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "symbol_path" },
                    message:
                      "must have required property '" + "symbol_path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err235];
                  } else {
                    vErrors.push(err235);
                  }
                  errors++;
                }
                if (data94.occurrence_state === undefined) {
                  const err236 = {
                    instancePath: instancePath + "/risks/" + i9 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "occurrence_state" },
                    message:
                      "must have required property '" +
                      "occurrence_state" +
                      "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err236];
                  } else {
                    vErrors.push(err236);
                  }
                  errors++;
                }
                for (const key14 in data94) {
                  if (!(
                    key14 === "path" ||
                    key14 === "line_start" ||
                    key14 === "line_end" ||
                    key14 === "column" ||
                    key14 === "symbol_path" ||
                    key14 === "occurrence_state"
                  )) {
                    const err237 = {
                      instancePath: instancePath + "/risks/" + i9 + "/location",
                      schemaPath:
                        "#/$defs/finding/properties/location/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key14 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err237];
                    } else {
                      vErrors.push(err237);
                    }
                    errors++;
                  }
                }
                if (data94.path !== undefined) {
                  let data95 = data94.path;
                  if (typeof data95 === "string") {
                    if (func2(data95) < 1) {
                      const err238 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/location/path",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/path/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err238];
                      } else {
                        vErrors.push(err238);
                      }
                      errors++;
                    }
                    if (!pattern8.test(data95)) {
                      const err239 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/location/path",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/path/pattern",
                        keyword: "pattern",
                        params: {
                          pattern:
                            "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                        },
                        message:
                          'must match pattern "' +
                          "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                          '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err239];
                      } else {
                        vErrors.push(err239);
                      }
                      errors++;
                    }
                  } else {
                    const err240 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/location/path",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err240];
                    } else {
                      vErrors.push(err240);
                    }
                    errors++;
                  }
                }
                if (data94.line_start !== undefined) {
                  let data96 = data94.line_start;
                  if (!(
                    typeof data96 == "number" &&
                    !(data96 % 1) &&
                    !isNaN(data96)
                  )) {
                    const err241 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/location/line_start",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/line_start/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err241];
                    } else {
                      vErrors.push(err241);
                    }
                    errors++;
                  }
                  if (typeof data96 == "number") {
                    if (data96 < 1 || isNaN(data96)) {
                      const err242 = {
                        instancePath:
                          instancePath +
                          "/risks/" +
                          i9 +
                          "/location/line_start",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/line_start/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err242];
                      } else {
                        vErrors.push(err242);
                      }
                      errors++;
                    }
                  }
                }
                if (data94.line_end !== undefined) {
                  let data97 = data94.line_end;
                  if (!(
                    typeof data97 == "number" &&
                    !(data97 % 1) &&
                    !isNaN(data97)
                  )) {
                    const err243 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/location/line_end",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/line_end/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err243];
                    } else {
                      vErrors.push(err243);
                    }
                    errors++;
                  }
                  if (typeof data97 == "number") {
                    if (data97 < 1 || isNaN(data97)) {
                      const err244 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/location/line_end",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/line_end/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err244];
                      } else {
                        vErrors.push(err244);
                      }
                      errors++;
                    }
                  }
                }
                if (data94.column !== undefined) {
                  let data98 = data94.column;
                  if (!(
                    typeof data98 == "number" &&
                    !(data98 % 1) &&
                    !isNaN(data98)
                  )) {
                    const err245 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/location/column",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/column/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err245];
                    } else {
                      vErrors.push(err245);
                    }
                    errors++;
                  }
                  if (typeof data98 == "number") {
                    if (data98 < 1 || isNaN(data98)) {
                      const err246 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/location/column",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/column/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err246];
                      } else {
                        vErrors.push(err246);
                      }
                      errors++;
                    }
                  }
                }
                if (data94.symbol_path !== undefined) {
                  if (typeof data94.symbol_path !== "string") {
                    const err247 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/location/symbol_path",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/symbol_path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err247];
                    } else {
                      vErrors.push(err247);
                    }
                    errors++;
                  }
                }
                if (data94.occurrence_state !== undefined) {
                  let data100 = data94.occurrence_state;
                  if (!(
                    data100 === "new" ||
                    data100 === "pre-existing" ||
                    data100 === "fixed" ||
                    data100 === "unclassified"
                  )) {
                    const err248 = {
                      instancePath:
                        instancePath +
                        "/risks/" +
                        i9 +
                        "/location/occurrence_state",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/occurrence_state/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.location.properties
                            .occurrence_state.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err248];
                    } else {
                      vErrors.push(err248);
                    }
                    errors++;
                  }
                }
              } else {
                const err249 = {
                  instancePath: instancePath + "/risks/" + i9 + "/location",
                  schemaPath: "#/$defs/finding/properties/location/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err249];
                } else {
                  vErrors.push(err249);
                }
                errors++;
              }
            }
            if (data86.message !== undefined) {
              let data101 = data86.message;
              if (typeof data101 === "string") {
                if (func2(data101) < 1) {
                  const err250 = {
                    instancePath: instancePath + "/risks/" + i9 + "/message",
                    schemaPath: "#/$defs/finding/properties/message/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err250];
                  } else {
                    vErrors.push(err250);
                  }
                  errors++;
                }
              } else {
                const err251 = {
                  instancePath: instancePath + "/risks/" + i9 + "/message",
                  schemaPath: "#/$defs/finding/properties/message/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err251];
                } else {
                  vErrors.push(err251);
                }
                errors++;
              }
            }
            if (data86.trigger !== undefined) {
              if (typeof data86.trigger !== "string") {
                const err252 = {
                  instancePath: instancePath + "/risks/" + i9 + "/trigger",
                  schemaPath: "#/$defs/finding/properties/trigger/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err252];
                } else {
                  vErrors.push(err252);
                }
                errors++;
              }
            }
            if (data86.impact !== undefined) {
              let data103 = data86.impact;
              if (typeof data103 === "string") {
                if (func2(data103) < 1) {
                  const err253 = {
                    instancePath: instancePath + "/risks/" + i9 + "/impact",
                    schemaPath: "#/$defs/finding/properties/impact/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err253];
                  } else {
                    vErrors.push(err253);
                  }
                  errors++;
                }
              } else {
                const err254 = {
                  instancePath: instancePath + "/risks/" + i9 + "/impact",
                  schemaPath: "#/$defs/finding/properties/impact/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err254];
                } else {
                  vErrors.push(err254);
                }
                errors++;
              }
            }
            if (data86.suggested_fix !== undefined) {
              let data104 = data86.suggested_fix;
              if (typeof data104 === "string") {
                if (func2(data104) < 1) {
                  const err255 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/suggested_fix",
                    schemaPath:
                      "#/$defs/finding/properties/suggested_fix/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err255];
                  } else {
                    vErrors.push(err255);
                  }
                  errors++;
                }
              } else {
                const err256 = {
                  instancePath:
                    instancePath + "/risks/" + i9 + "/suggested_fix",
                  schemaPath: "#/$defs/finding/properties/suggested_fix/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err256];
                } else {
                  vErrors.push(err256);
                }
                errors++;
              }
            }
            if (data86.evidence !== undefined) {
              let data105 = data86.evidence;
              if (Array.isArray(data105)) {
                const len10 = data105.length;
                for (let i10 = 0; i10 < len10; i10++) {
                  let data106 = data105[i10];
                  if (typeof data106 === "string") {
                    if (func2(data106) < 1) {
                      const err257 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/evidence/" + i10,
                        schemaPath:
                          "#/$defs/finding/properties/evidence/items/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err257];
                      } else {
                        vErrors.push(err257);
                      }
                      errors++;
                    }
                  } else {
                    const err258 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/evidence/" + i10,
                      schemaPath:
                        "#/$defs/finding/properties/evidence/items/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err258];
                    } else {
                      vErrors.push(err258);
                    }
                    errors++;
                  }
                }
              } else {
                const err259 = {
                  instancePath: instancePath + "/risks/" + i9 + "/evidence",
                  schemaPath: "#/$defs/finding/properties/evidence/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err259];
                } else {
                  vErrors.push(err259);
                }
                errors++;
              }
            }
            if (data86.source !== undefined) {
              let data107 = data86.source;
              const _errs230 = errors;
              let valid50 = false;
              let passing1 = null;
              const _errs231 = errors;
              if (
                data107 &&
                typeof data107 == "object" &&
                !Array.isArray(data107)
              ) {
                if (data107.tool === undefined) {
                  const err260 = {
                    instancePath: instancePath + "/risks/" + i9 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/0/required",
                    keyword: "required",
                    params: { missingProperty: "tool" },
                    message: "must have required property '" + "tool" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err260];
                  } else {
                    vErrors.push(err260);
                  }
                  errors++;
                }
                if (data107.version === undefined) {
                  const err261 = {
                    instancePath: instancePath + "/risks/" + i9 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/0/required",
                    keyword: "required",
                    params: { missingProperty: "version" },
                    message: "must have required property '" + "version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err261];
                  } else {
                    vErrors.push(err261);
                  }
                  errors++;
                }
                for (const key15 in data107) {
                  if (!(key15 === "tool" || key15 === "version")) {
                    const err262 = {
                      instancePath: instancePath + "/risks/" + i9 + "/source",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key15 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err262];
                    } else {
                      vErrors.push(err262);
                    }
                    errors++;
                  }
                }
                if (data107.tool !== undefined) {
                  let data108 = data107.tool;
                  if (typeof data108 === "string") {
                    if (func2(data108) < 1) {
                      const err263 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/source/tool",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/0/properties/tool/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err263];
                      } else {
                        vErrors.push(err263);
                      }
                      errors++;
                    }
                  } else {
                    const err264 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/source/tool",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/properties/tool/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err264];
                    } else {
                      vErrors.push(err264);
                    }
                    errors++;
                  }
                }
                if (data107.version !== undefined) {
                  let data109 = data107.version;
                  if (typeof data109 === "string") {
                    if (func2(data109) < 1) {
                      const err265 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/source/version",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/0/properties/version/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err265];
                      } else {
                        vErrors.push(err265);
                      }
                      errors++;
                    }
                  } else {
                    const err266 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/source/version",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/properties/version/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err266];
                    } else {
                      vErrors.push(err266);
                    }
                    errors++;
                  }
                }
              } else {
                const err267 = {
                  instancePath: instancePath + "/risks/" + i9 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf/0/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err267];
                } else {
                  vErrors.push(err267);
                }
                errors++;
              }
              var _valid4 = _errs231 === errors;
              if (_valid4) {
                valid50 = true;
                passing1 = 0;
                var props1 = true;
              }
              const _errs238 = errors;
              if (
                data107 &&
                typeof data107 == "object" &&
                !Array.isArray(data107)
              ) {
                if (data107.agent === undefined) {
                  const err268 = {
                    instancePath: instancePath + "/risks/" + i9 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/1/required",
                    keyword: "required",
                    params: { missingProperty: "agent" },
                    message: "must have required property '" + "agent" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err268];
                  } else {
                    vErrors.push(err268);
                  }
                  errors++;
                }
                for (const key16 in data107) {
                  if (!(key16 === "agent")) {
                    const err269 = {
                      instancePath: instancePath + "/risks/" + i9 + "/source",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/1/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key16 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err269];
                    } else {
                      vErrors.push(err269);
                    }
                    errors++;
                  }
                }
                if (data107.agent !== undefined) {
                  let data110 = data107.agent;
                  if (typeof data110 === "string") {
                    if (func2(data110) < 1) {
                      const err270 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/source/agent",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/1/properties/agent/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err270];
                      } else {
                        vErrors.push(err270);
                      }
                      errors++;
                    }
                  } else {
                    const err271 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/source/agent",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/1/properties/agent/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err271];
                    } else {
                      vErrors.push(err271);
                    }
                    errors++;
                  }
                }
              } else {
                const err272 = {
                  instancePath: instancePath + "/risks/" + i9 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf/1/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err272];
                } else {
                  vErrors.push(err272);
                }
                errors++;
              }
              var _valid4 = _errs238 === errors;
              if (_valid4 && valid50) {
                valid50 = false;
                passing1 = [passing1, 1];
              } else {
                if (_valid4) {
                  valid50 = true;
                  passing1 = 1;
                  if (props1 !== true) {
                    props1 = true;
                  }
                }
              }
              if (!valid50) {
                const err273 = {
                  instancePath: instancePath + "/risks/" + i9 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf",
                  keyword: "oneOf",
                  params: { passingSchemas: passing1 },
                  message: "must match exactly one schema in oneOf",
                };
                if (vErrors === null) {
                  vErrors = [err273];
                } else {
                  vErrors.push(err273);
                }
                errors++;
              } else {
                errors = _errs230;
                if (vErrors !== null) {
                  if (_errs230) {
                    vErrors.length = _errs230;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
            if (data86.locations !== undefined) {
              let data111 = data86.locations;
              if (Array.isArray(data111)) {
                if (data111.length < 1) {
                  const err274 = {
                    instancePath: instancePath + "/risks/" + i9 + "/locations",
                    schemaPath: "#/$defs/finding/properties/locations/minItems",
                    keyword: "minItems",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 items",
                  };
                  if (vErrors === null) {
                    vErrors = [err274];
                  } else {
                    vErrors.push(err274);
                  }
                  errors++;
                }
                const len11 = data111.length;
                for (let i11 = 0; i11 < len11; i11++) {
                  let data112 = data111[i11];
                  if (
                    data112 &&
                    typeof data112 == "object" &&
                    !Array.isArray(data112)
                  ) {
                    if (data112.path === undefined) {
                      const err275 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/locations/" + i11,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "path" },
                        message: "must have required property '" + "path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err275];
                      } else {
                        vErrors.push(err275);
                      }
                      errors++;
                    }
                    if (data112.line_start === undefined) {
                      const err276 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/locations/" + i11,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_start" },
                        message:
                          "must have required property '" + "line_start" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err276];
                      } else {
                        vErrors.push(err276);
                      }
                      errors++;
                    }
                    if (data112.line_end === undefined) {
                      const err277 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/locations/" + i11,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_end" },
                        message:
                          "must have required property '" + "line_end" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err277];
                      } else {
                        vErrors.push(err277);
                      }
                      errors++;
                    }
                    if (data112.symbol_path === undefined) {
                      const err278 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/locations/" + i11,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "symbol_path" },
                        message:
                          "must have required property '" + "symbol_path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err278];
                      } else {
                        vErrors.push(err278);
                      }
                      errors++;
                    }
                    if (data112.occurrence_state === undefined) {
                      const err279 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/locations/" + i11,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "occurrence_state" },
                        message:
                          "must have required property '" +
                          "occurrence_state" +
                          "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err279];
                      } else {
                        vErrors.push(err279);
                      }
                      errors++;
                    }
                    for (const key17 in data112) {
                      if (!(
                        key17 === "path" ||
                        key17 === "line_start" ||
                        key17 === "line_end" ||
                        key17 === "column" ||
                        key17 === "symbol_path" ||
                        key17 === "occurrence_state" ||
                        key17 === "id"
                      )) {
                        const err280 = {
                          instancePath:
                            instancePath + "/risks/" + i9 + "/locations/" + i11,
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/additionalProperties",
                          keyword: "additionalProperties",
                          params: { additionalProperty: key17 },
                          message: "must NOT have additional properties",
                        };
                        if (vErrors === null) {
                          vErrors = [err280];
                        } else {
                          vErrors.push(err280);
                        }
                        errors++;
                      }
                    }
                    if (data112.path !== undefined) {
                      let data113 = data112.path;
                      if (typeof data113 === "string") {
                        if (func2(data113) < 1) {
                          const err281 = {
                            instancePath:
                              instancePath +
                              "/risks/" +
                              i9 +
                              "/locations/" +
                              i11 +
                              "/path",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/path/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err281];
                          } else {
                            vErrors.push(err281);
                          }
                          errors++;
                        }
                        if (!pattern8.test(data113)) {
                          const err282 = {
                            instancePath:
                              instancePath +
                              "/risks/" +
                              i9 +
                              "/locations/" +
                              i11 +
                              "/path",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/path/pattern",
                            keyword: "pattern",
                            params: {
                              pattern:
                                "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                            },
                            message:
                              'must match pattern "' +
                              "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                              '"',
                          };
                          if (vErrors === null) {
                            vErrors = [err282];
                          } else {
                            vErrors.push(err282);
                          }
                          errors++;
                        }
                      } else {
                        const err283 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/locations/" +
                            i11 +
                            "/path",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err283];
                        } else {
                          vErrors.push(err283);
                        }
                        errors++;
                      }
                    }
                    if (data112.line_start !== undefined) {
                      let data114 = data112.line_start;
                      if (!(
                        typeof data114 == "number" &&
                        !(data114 % 1) &&
                        !isNaN(data114)
                      )) {
                        const err284 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/locations/" +
                            i11 +
                            "/line_start",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/line_start/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err284];
                        } else {
                          vErrors.push(err284);
                        }
                        errors++;
                      }
                      if (typeof data114 == "number") {
                        if (data114 < 1 || isNaN(data114)) {
                          const err285 = {
                            instancePath:
                              instancePath +
                              "/risks/" +
                              i9 +
                              "/locations/" +
                              i11 +
                              "/line_start",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/line_start/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err285];
                          } else {
                            vErrors.push(err285);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data112.line_end !== undefined) {
                      let data115 = data112.line_end;
                      if (!(
                        typeof data115 == "number" &&
                        !(data115 % 1) &&
                        !isNaN(data115)
                      )) {
                        const err286 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/locations/" +
                            i11 +
                            "/line_end",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/line_end/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err286];
                        } else {
                          vErrors.push(err286);
                        }
                        errors++;
                      }
                      if (typeof data115 == "number") {
                        if (data115 < 1 || isNaN(data115)) {
                          const err287 = {
                            instancePath:
                              instancePath +
                              "/risks/" +
                              i9 +
                              "/locations/" +
                              i11 +
                              "/line_end",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/line_end/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err287];
                          } else {
                            vErrors.push(err287);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data112.column !== undefined) {
                      let data116 = data112.column;
                      if (!(
                        typeof data116 == "number" &&
                        !(data116 % 1) &&
                        !isNaN(data116)
                      )) {
                        const err288 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/locations/" +
                            i11 +
                            "/column",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/column/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err288];
                        } else {
                          vErrors.push(err288);
                        }
                        errors++;
                      }
                      if (typeof data116 == "number") {
                        if (data116 < 1 || isNaN(data116)) {
                          const err289 = {
                            instancePath:
                              instancePath +
                              "/risks/" +
                              i9 +
                              "/locations/" +
                              i11 +
                              "/column",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/column/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err289];
                          } else {
                            vErrors.push(err289);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data112.symbol_path !== undefined) {
                      if (typeof data112.symbol_path !== "string") {
                        const err290 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/locations/" +
                            i11 +
                            "/symbol_path",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/symbol_path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err290];
                        } else {
                          vErrors.push(err290);
                        }
                        errors++;
                      }
                    }
                    if (data112.occurrence_state !== undefined) {
                      let data118 = data112.occurrence_state;
                      if (!(
                        data118 === "new" ||
                        data118 === "pre-existing" ||
                        data118 === "fixed" ||
                        data118 === "unclassified"
                      )) {
                        const err291 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/locations/" +
                            i11 +
                            "/occurrence_state",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/occurrence_state/enum",
                          keyword: "enum",
                          params: {
                            allowedValues:
                              schema34.properties.locations.items.properties
                                .occurrence_state.enum,
                          },
                          message: "must be equal to one of the allowed values",
                        };
                        if (vErrors === null) {
                          vErrors = [err291];
                        } else {
                          vErrors.push(err291);
                        }
                        errors++;
                      }
                    }
                    if (data112.id !== undefined) {
                      let data119 = data112.id;
                      if (typeof data119 === "string") {
                        if (func2(data119) < 1) {
                          const err292 = {
                            instancePath:
                              instancePath +
                              "/risks/" +
                              i9 +
                              "/locations/" +
                              i11 +
                              "/id",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/id/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err292];
                          } else {
                            vErrors.push(err292);
                          }
                          errors++;
                        }
                      } else {
                        const err293 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/locations/" +
                            i11 +
                            "/id",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/id/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err293];
                        } else {
                          vErrors.push(err293);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err294 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/locations/" + i11,
                      schemaPath:
                        "#/$defs/finding/properties/locations/items/type",
                      keyword: "type",
                      params: { type: "object" },
                      message: "must be object",
                    };
                    if (vErrors === null) {
                      vErrors = [err294];
                    } else {
                      vErrors.push(err294);
                    }
                    errors++;
                  }
                }
              } else {
                const err295 = {
                  instancePath: instancePath + "/risks/" + i9 + "/locations",
                  schemaPath: "#/$defs/finding/properties/locations/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err295];
                } else {
                  vErrors.push(err295);
                }
                errors++;
              }
            }
            if (data86.advisory !== undefined) {
              let data120 = data86.advisory;
              if (
                data120 &&
                typeof data120 == "object" &&
                !Array.isArray(data120)
              ) {
                if (data120.id === undefined) {
                  const err296 = {
                    instancePath: instancePath + "/risks/" + i9 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "id" },
                    message: "must have required property '" + "id" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err296];
                  } else {
                    vErrors.push(err296);
                  }
                  errors++;
                }
                if (data120.aliases === undefined) {
                  const err297 = {
                    instancePath: instancePath + "/risks/" + i9 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "aliases" },
                    message: "must have required property '" + "aliases" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err297];
                  } else {
                    vErrors.push(err297);
                  }
                  errors++;
                }
                if (data120.severity === undefined) {
                  const err298 = {
                    instancePath: instancePath + "/risks/" + i9 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "severity" },
                    message: "must have required property '" + "severity" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err298];
                  } else {
                    vErrors.push(err298);
                  }
                  errors++;
                }
                if (data120.fixed_version === undefined) {
                  const err299 = {
                    instancePath: instancePath + "/risks/" + i9 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "fixed_version" },
                    message:
                      "must have required property '" + "fixed_version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err299];
                  } else {
                    vErrors.push(err299);
                  }
                  errors++;
                }
                if (data120.url === undefined) {
                  const err300 = {
                    instancePath: instancePath + "/risks/" + i9 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "url" },
                    message: "must have required property '" + "url" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err300];
                  } else {
                    vErrors.push(err300);
                  }
                  errors++;
                }
                for (const key18 in data120) {
                  if (!(
                    key18 === "id" ||
                    key18 === "aliases" ||
                    key18 === "severity" ||
                    key18 === "fixed_version" ||
                    key18 === "url"
                  )) {
                    const err301 = {
                      instancePath: instancePath + "/risks/" + i9 + "/advisory",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key18 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err301];
                    } else {
                      vErrors.push(err301);
                    }
                    errors++;
                  }
                }
                if (data120.id !== undefined) {
                  let data121 = data120.id;
                  if (typeof data121 === "string") {
                    if (func2(data121) < 1) {
                      const err302 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/advisory/id",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/id/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err302];
                      } else {
                        vErrors.push(err302);
                      }
                      errors++;
                    }
                  } else {
                    const err303 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/advisory/id",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/id/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err303];
                    } else {
                      vErrors.push(err303);
                    }
                    errors++;
                  }
                }
                if (data120.aliases !== undefined) {
                  let data122 = data120.aliases;
                  if (Array.isArray(data122)) {
                    const len12 = data122.length;
                    for (let i12 = 0; i12 < len12; i12++) {
                      let data123 = data122[i12];
                      if (typeof data123 === "string") {
                        if (func2(data123) < 1) {
                          const err304 = {
                            instancePath:
                              instancePath +
                              "/risks/" +
                              i9 +
                              "/advisory/aliases/" +
                              i12,
                            schemaPath:
                              "#/$defs/finding/properties/advisory/properties/aliases/items/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err304];
                          } else {
                            vErrors.push(err304);
                          }
                          errors++;
                        }
                      } else {
                        const err305 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/advisory/aliases/" +
                            i12,
                          schemaPath:
                            "#/$defs/finding/properties/advisory/properties/aliases/items/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err305];
                        } else {
                          vErrors.push(err305);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err306 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/advisory/aliases",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/aliases/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err306];
                    } else {
                      vErrors.push(err306);
                    }
                    errors++;
                  }
                }
                if (data120.severity !== undefined) {
                  let data124 = data120.severity;
                  if (!(
                    data124 === "critical" ||
                    data124 === "high" ||
                    data124 === "moderate" ||
                    data124 === "low" ||
                    data124 === "unknown"
                  )) {
                    const err307 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/advisory/severity",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/severity/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.advisory.properties.severity.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err307];
                    } else {
                      vErrors.push(err307);
                    }
                    errors++;
                  }
                }
                if (data120.fixed_version !== undefined) {
                  let data125 = data120.fixed_version;
                  if (typeof data125 === "string") {
                    if (func2(data125) < 1) {
                      const err308 = {
                        instancePath:
                          instancePath +
                          "/risks/" +
                          i9 +
                          "/advisory/fixed_version",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/fixed_version/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err308];
                      } else {
                        vErrors.push(err308);
                      }
                      errors++;
                    }
                  } else {
                    const err309 = {
                      instancePath:
                        instancePath +
                        "/risks/" +
                        i9 +
                        "/advisory/fixed_version",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/fixed_version/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err309];
                    } else {
                      vErrors.push(err309);
                    }
                    errors++;
                  }
                }
                if (data120.url !== undefined) {
                  let data126 = data120.url;
                  if (typeof data126 === "string") {
                    if (!pattern10.test(data126)) {
                      const err310 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/advisory/url",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/url/pattern",
                        keyword: "pattern",
                        params: { pattern: "^https://" },
                        message: 'must match pattern "' + "^https://" + '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err310];
                      } else {
                        vErrors.push(err310);
                      }
                      errors++;
                    }
                  } else {
                    const err311 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/advisory/url",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/url/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err311];
                    } else {
                      vErrors.push(err311);
                    }
                    errors++;
                  }
                }
              } else {
                const err312 = {
                  instancePath: instancePath + "/risks/" + i9 + "/advisory",
                  schemaPath: "#/$defs/finding/properties/advisory/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err312];
                } else {
                  vErrors.push(err312);
                }
                errors++;
              }
            }
            if (data86.round !== undefined) {
              let data127 = data86.round;
              if (!(
                typeof data127 == "number" &&
                !(data127 % 1) &&
                !isNaN(data127)
              )) {
                const err313 = {
                  instancePath: instancePath + "/risks/" + i9 + "/round",
                  schemaPath: "#/$defs/finding/properties/round/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err313];
                } else {
                  vErrors.push(err313);
                }
                errors++;
              }
              if (typeof data127 == "number") {
                if (data127 < 1 || isNaN(data127)) {
                  const err314 = {
                    instancePath: instancePath + "/risks/" + i9 + "/round",
                    schemaPath: "#/$defs/finding/properties/round/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err314];
                  } else {
                    vErrors.push(err314);
                  }
                  errors++;
                }
              }
            }
            if (data86.first_posted_in !== undefined) {
              let data128 = data86.first_posted_in;
              if (typeof data128 === "string") {
                if (func2(data128) < 1) {
                  const err315 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/first_posted_in",
                    schemaPath:
                      "#/$defs/finding/properties/first_posted_in/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err315];
                  } else {
                    vErrors.push(err315);
                  }
                  errors++;
                }
              } else {
                const err316 = {
                  instancePath:
                    instancePath + "/risks/" + i9 + "/first_posted_in",
                  schemaPath: "#/$defs/finding/properties/first_posted_in/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err316];
                } else {
                  vErrors.push(err316);
                }
                errors++;
              }
            }
            if (data86.author_response !== undefined) {
              let data129 = data86.author_response;
              if (
                data129 &&
                typeof data129 == "object" &&
                !Array.isArray(data129)
              ) {
                if (data129.reason === undefined) {
                  const err317 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "reason" },
                    message: "must have required property '" + "reason" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err317];
                  } else {
                    vErrors.push(err317);
                  }
                  errors++;
                }
                if (data129.actor === undefined) {
                  const err318 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "actor" },
                    message: "must have required property '" + "actor" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err318];
                  } else {
                    vErrors.push(err318);
                  }
                  errors++;
                }
                if (data129.at === undefined) {
                  const err319 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "at" },
                    message: "must have required property '" + "at" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err319];
                  } else {
                    vErrors.push(err319);
                  }
                  errors++;
                }
                for (const key19 in data129) {
                  if (!(
                    key19 === "reason" ||
                    key19 === "actor" ||
                    key19 === "at" ||
                    key19 === "note"
                  )) {
                    const err320 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/author_response",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key19 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err320];
                    } else {
                      vErrors.push(err320);
                    }
                    errors++;
                  }
                }
                if (data129.reason !== undefined) {
                  let data130 = data129.reason;
                  if (!(
                    data130 === "fixed" ||
                    data130 === "wrong" ||
                    data130 === "intentional" ||
                    data130 === "irrelevant" ||
                    data130 === "style"
                  )) {
                    const err321 = {
                      instancePath:
                        instancePath +
                        "/risks/" +
                        i9 +
                        "/author_response/reason",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/reason/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.author_response.properties.reason
                            .enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err321];
                    } else {
                      vErrors.push(err321);
                    }
                    errors++;
                  }
                }
                if (data129.actor !== undefined) {
                  let data131 = data129.actor;
                  if (typeof data131 === "string") {
                    if (func2(data131) < 1) {
                      const err322 = {
                        instancePath:
                          instancePath +
                          "/risks/" +
                          i9 +
                          "/author_response/actor",
                        schemaPath:
                          "#/$defs/finding/properties/author_response/properties/actor/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err322];
                      } else {
                        vErrors.push(err322);
                      }
                      errors++;
                    }
                  } else {
                    const err323 = {
                      instancePath:
                        instancePath +
                        "/risks/" +
                        i9 +
                        "/author_response/actor",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/actor/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err323];
                    } else {
                      vErrors.push(err323);
                    }
                    errors++;
                  }
                }
                if (data129.at !== undefined) {
                  let data132 = data129.at;
                  if (typeof data132 === "string") {
                    if (!formats0.validate(data132)) {
                      const err324 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/author_response/at",
                        schemaPath:
                          "#/$defs/finding/properties/author_response/properties/at/format",
                        keyword: "format",
                        params: { format: "date-time" },
                        message: 'must match format "' + "date-time" + '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err324];
                      } else {
                        vErrors.push(err324);
                      }
                      errors++;
                    }
                  } else {
                    const err325 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/author_response/at",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/at/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err325];
                    } else {
                      vErrors.push(err325);
                    }
                    errors++;
                  }
                }
                if (data129.note !== undefined) {
                  if (typeof data129.note !== "string") {
                    const err326 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/author_response/note",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/note/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err326];
                    } else {
                      vErrors.push(err326);
                    }
                    errors++;
                  }
                }
              } else {
                const err327 = {
                  instancePath:
                    instancePath + "/risks/" + i9 + "/author_response",
                  schemaPath: "#/$defs/finding/properties/author_response/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err327];
                } else {
                  vErrors.push(err327);
                }
                errors++;
              }
            }
            if (data86.status !== undefined) {
              let data134 = data86.status;
              if (!(
                data134 === "open" ||
                data134 === "fixed" ||
                data134 === "dismissed"
              )) {
                const err328 = {
                  instancePath: instancePath + "/risks/" + i9 + "/status",
                  schemaPath: "#/$defs/finding/properties/status/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.status.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err328];
                } else {
                  vErrors.push(err328);
                }
                errors++;
              }
            }
            if (data86.resolution !== undefined) {
              let data135 = data86.resolution;
              if (
                data135 &&
                typeof data135 == "object" &&
                !Array.isArray(data135)
              ) {
                for (const key20 in data135) {
                  if (!(key20 === "fixed_in" || key20 === "note")) {
                    const err329 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/resolution",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key20 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err329];
                    } else {
                      vErrors.push(err329);
                    }
                    errors++;
                  }
                }
                if (data135.fixed_in !== undefined) {
                  let data136 = data135.fixed_in;
                  if (typeof data136 === "string") {
                    if (func2(data136) < 1) {
                      const err330 = {
                        instancePath:
                          instancePath +
                          "/risks/" +
                          i9 +
                          "/resolution/fixed_in",
                        schemaPath:
                          "#/$defs/finding/properties/resolution/properties/fixed_in/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err330];
                      } else {
                        vErrors.push(err330);
                      }
                      errors++;
                    }
                  } else {
                    const err331 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/resolution/fixed_in",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/properties/fixed_in/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err331];
                    } else {
                      vErrors.push(err331);
                    }
                    errors++;
                  }
                }
                if (data135.note !== undefined) {
                  let data137 = data135.note;
                  if (typeof data137 === "string") {
                    if (func2(data137) < 1) {
                      const err332 = {
                        instancePath:
                          instancePath + "/risks/" + i9 + "/resolution/note",
                        schemaPath:
                          "#/$defs/finding/properties/resolution/properties/note/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err332];
                      } else {
                        vErrors.push(err332);
                      }
                      errors++;
                    }
                  } else {
                    const err333 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/resolution/note",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/properties/note/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err333];
                    } else {
                      vErrors.push(err333);
                    }
                    errors++;
                  }
                }
              } else {
                const err334 = {
                  instancePath: instancePath + "/risks/" + i9 + "/resolution",
                  schemaPath: "#/$defs/finding/properties/resolution/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err334];
                } else {
                  vErrors.push(err334);
                }
                errors++;
              }
            }
            if (data86.verification !== undefined) {
              let data138 = data86.verification;
              if (
                data138 &&
                typeof data138 == "object" &&
                !Array.isArray(data138)
              ) {
                if (data138.voters === undefined) {
                  const err335 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "voters" },
                    message: "must have required property '" + "voters" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err335];
                  } else {
                    vErrors.push(err335);
                  }
                  errors++;
                }
                if (data138.agreeing === undefined) {
                  const err336 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "agreeing" },
                    message: "must have required property '" + "agreeing" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err336];
                  } else {
                    vErrors.push(err336);
                  }
                  errors++;
                }
                if (data138.blind_match === undefined) {
                  const err337 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "blind_match" },
                    message:
                      "must have required property '" + "blind_match" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err337];
                  } else {
                    vErrors.push(err337);
                  }
                  errors++;
                }
                if (data138.split === undefined) {
                  const err338 = {
                    instancePath:
                      instancePath + "/risks/" + i9 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "split" },
                    message: "must have required property '" + "split" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err338];
                  } else {
                    vErrors.push(err338);
                  }
                  errors++;
                }
                for (const key21 in data138) {
                  if (!(
                    key21 === "voters" ||
                    key21 === "agreeing" ||
                    key21 === "blind_match" ||
                    key21 === "split"
                  )) {
                    const err339 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/verification",
                      schemaPath:
                        "#/$defs/finding/properties/verification/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key21 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err339];
                    } else {
                      vErrors.push(err339);
                    }
                    errors++;
                  }
                }
                if (data138.voters !== undefined) {
                  let data139 = data138.voters;
                  if (!(
                    typeof data139 == "number" &&
                    !(data139 % 1) &&
                    !isNaN(data139)
                  )) {
                    const err340 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/verification/voters",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/voters/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err340];
                    } else {
                      vErrors.push(err340);
                    }
                    errors++;
                  }
                  if (typeof data139 == "number") {
                    if (data139 < 1 || isNaN(data139)) {
                      const err341 = {
                        instancePath:
                          instancePath +
                          "/risks/" +
                          i9 +
                          "/verification/voters",
                        schemaPath:
                          "#/$defs/finding/properties/verification/properties/voters/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err341];
                      } else {
                        vErrors.push(err341);
                      }
                      errors++;
                    }
                  }
                }
                if (data138.agreeing !== undefined) {
                  let data140 = data138.agreeing;
                  if (!(
                    typeof data140 == "number" &&
                    !(data140 % 1) &&
                    !isNaN(data140)
                  )) {
                    const err342 = {
                      instancePath:
                        instancePath +
                        "/risks/" +
                        i9 +
                        "/verification/agreeing",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/agreeing/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err342];
                    } else {
                      vErrors.push(err342);
                    }
                    errors++;
                  }
                  if (typeof data140 == "number") {
                    if (data140 < 0 || isNaN(data140)) {
                      const err343 = {
                        instancePath:
                          instancePath +
                          "/risks/" +
                          i9 +
                          "/verification/agreeing",
                        schemaPath:
                          "#/$defs/finding/properties/verification/properties/agreeing/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 0 },
                        message: "must be >= 0",
                      };
                      if (vErrors === null) {
                        vErrors = [err343];
                      } else {
                        vErrors.push(err343);
                      }
                      errors++;
                    }
                  }
                }
                if (data138.blind_match !== undefined) {
                  let data141 = data138.blind_match;
                  if (Array.isArray(data141)) {
                    const len13 = data141.length;
                    for (let i13 = 0; i13 < len13; i13++) {
                      let data142 = data141[i13];
                      if (!(
                        data142 === "same" ||
                        data142 === "related" ||
                        data142 === "none"
                      )) {
                        const err344 = {
                          instancePath:
                            instancePath +
                            "/risks/" +
                            i9 +
                            "/verification/blind_match/" +
                            i13,
                          schemaPath:
                            "#/$defs/finding/properties/verification/properties/blind_match/items/enum",
                          keyword: "enum",
                          params: {
                            allowedValues:
                              schema34.properties.verification.properties
                                .blind_match.items.enum,
                          },
                          message: "must be equal to one of the allowed values",
                        };
                        if (vErrors === null) {
                          vErrors = [err344];
                        } else {
                          vErrors.push(err344);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err345 = {
                      instancePath:
                        instancePath +
                        "/risks/" +
                        i9 +
                        "/verification/blind_match",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/blind_match/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err345];
                    } else {
                      vErrors.push(err345);
                    }
                    errors++;
                  }
                }
                if (data138.split !== undefined) {
                  if (typeof data138.split !== "boolean") {
                    const err346 = {
                      instancePath:
                        instancePath + "/risks/" + i9 + "/verification/split",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/split/type",
                      keyword: "type",
                      params: { type: "boolean" },
                      message: "must be boolean",
                    };
                    if (vErrors === null) {
                      vErrors = [err346];
                    } else {
                      vErrors.push(err346);
                    }
                    errors++;
                  }
                }
              } else {
                const err347 = {
                  instancePath: instancePath + "/risks/" + i9 + "/verification",
                  schemaPath: "#/$defs/finding/properties/verification/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err347];
                } else {
                  vErrors.push(err347);
                }
                errors++;
              }
            }
          } else {
            const err348 = {
              instancePath: instancePath + "/risks/" + i9,
              schemaPath: "#/$defs/finding/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err348];
            } else {
              vErrors.push(err348);
            }
            errors++;
          }
        }
      } else {
        const err349 = {
          instancePath: instancePath + "/risks",
          schemaPath: "#/properties/risks/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err349];
        } else {
          vErrors.push(err349);
        }
        errors++;
      }
    }
    if (data.incomplete !== undefined) {
      let data144 = data.incomplete;
      if (Array.isArray(data144)) {
        const len14 = data144.length;
        for (let i14 = 0; i14 < len14; i14++) {
          if (
            !validate22(data144[i14], {
              instancePath: instancePath + "/incomplete/" + i14,
              parentData: data144,
              parentDataProperty: i14,
              rootData,
              dynamicAnchors,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate22.errors
                : vErrors.concat(validate22.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err350 = {
          instancePath: instancePath + "/incomplete",
          schemaPath: "#/properties/incomplete/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err350];
        } else {
          vErrors.push(err350);
        }
        errors++;
      }
    }
    if (data.deferred !== undefined) {
      let data146 = data.deferred;
      if (Array.isArray(data146)) {
        const len15 = data146.length;
        for (let i15 = 0; i15 < len15; i15++) {
          let data147 = data146[i15];
          if (
            data147 &&
            typeof data147 == "object" &&
            !Array.isArray(data147)
          ) {
            if (data147.step === undefined) {
              const err351 = {
                instancePath: instancePath + "/deferred/" + i15,
                schemaPath: "#/properties/deferred/items/required",
                keyword: "required",
                params: { missingProperty: "step" },
                message: "must have required property '" + "step" + "'",
              };
              if (vErrors === null) {
                vErrors = [err351];
              } else {
                vErrors.push(err351);
              }
              errors++;
            }
            if (data147.reason === undefined) {
              const err352 = {
                instancePath: instancePath + "/deferred/" + i15,
                schemaPath: "#/properties/deferred/items/required",
                keyword: "required",
                params: { missingProperty: "reason" },
                message: "must have required property '" + "reason" + "'",
              };
              if (vErrors === null) {
                vErrors = [err352];
              } else {
                vErrors.push(err352);
              }
              errors++;
            }
            for (const key22 in data147) {
              if (!(key22 === "step" || key22 === "reason")) {
                const err353 = {
                  instancePath: instancePath + "/deferred/" + i15,
                  schemaPath:
                    "#/properties/deferred/items/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key22 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err353];
                } else {
                  vErrors.push(err353);
                }
                errors++;
              }
            }
            if (data147.step !== undefined) {
              let data148 = data147.step;
              if (typeof data148 === "string") {
                if (func2(data148) < 1) {
                  const err354 = {
                    instancePath: instancePath + "/deferred/" + i15 + "/step",
                    schemaPath:
                      "#/properties/deferred/items/properties/step/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err354];
                  } else {
                    vErrors.push(err354);
                  }
                  errors++;
                }
              } else {
                const err355 = {
                  instancePath: instancePath + "/deferred/" + i15 + "/step",
                  schemaPath:
                    "#/properties/deferred/items/properties/step/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err355];
                } else {
                  vErrors.push(err355);
                }
                errors++;
              }
            }
            if (data147.reason !== undefined) {
              if ("no_endpoint" !== data147.reason) {
                const err356 = {
                  instancePath: instancePath + "/deferred/" + i15 + "/reason",
                  schemaPath:
                    "#/properties/deferred/items/properties/reason/const",
                  keyword: "const",
                  params: { allowedValue: "no_endpoint" },
                  message: "must be equal to constant",
                };
                if (vErrors === null) {
                  vErrors = [err356];
                } else {
                  vErrors.push(err356);
                }
                errors++;
              }
            }
          } else {
            const err357 = {
              instancePath: instancePath + "/deferred/" + i15,
              schemaPath: "#/properties/deferred/items/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err357];
            } else {
              vErrors.push(err357);
            }
            errors++;
          }
        }
      } else {
        const err358 = {
          instancePath: instancePath + "/deferred",
          schemaPath: "#/properties/deferred/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err358];
        } else {
          vErrors.push(err358);
        }
        errors++;
      }
    }
    if (data.excluded !== undefined) {
      let data150 = data.excluded;
      if (Array.isArray(data150)) {
        const len16 = data150.length;
        for (let i16 = 0; i16 < len16; i16++) {
          let data151 = data150[i16];
          if (
            data151 &&
            typeof data151 == "object" &&
            !Array.isArray(data151)
          ) {
            if (data151.path === undefined) {
              const err359 = {
                instancePath: instancePath + "/excluded/" + i16,
                schemaPath: "#/properties/excluded/items/required",
                keyword: "required",
                params: { missingProperty: "path" },
                message: "must have required property '" + "path" + "'",
              };
              if (vErrors === null) {
                vErrors = [err359];
              } else {
                vErrors.push(err359);
              }
              errors++;
            }
            if (data151.reason === undefined) {
              const err360 = {
                instancePath: instancePath + "/excluded/" + i16,
                schemaPath: "#/properties/excluded/items/required",
                keyword: "required",
                params: { missingProperty: "reason" },
                message: "must have required property '" + "reason" + "'",
              };
              if (vErrors === null) {
                vErrors = [err360];
              } else {
                vErrors.push(err360);
              }
              errors++;
            }
            for (const key23 in data151) {
              if (!(key23 === "path" || key23 === "reason")) {
                const err361 = {
                  instancePath: instancePath + "/excluded/" + i16,
                  schemaPath:
                    "#/properties/excluded/items/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key23 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err361];
                } else {
                  vErrors.push(err361);
                }
                errors++;
              }
            }
            if (data151.path !== undefined) {
              let data152 = data151.path;
              if (typeof data152 === "string") {
                if (func2(data152) < 1) {
                  const err362 = {
                    instancePath: instancePath + "/excluded/" + i16 + "/path",
                    schemaPath:
                      "#/properties/excluded/items/properties/path/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err362];
                  } else {
                    vErrors.push(err362);
                  }
                  errors++;
                }
              } else {
                const err363 = {
                  instancePath: instancePath + "/excluded/" + i16 + "/path",
                  schemaPath:
                    "#/properties/excluded/items/properties/path/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err363];
                } else {
                  vErrors.push(err363);
                }
                errors++;
              }
            }
            if (data151.reason !== undefined) {
              let data153 = data151.reason;
              if (typeof data153 === "string") {
                if (func2(data153) < 1) {
                  const err364 = {
                    instancePath: instancePath + "/excluded/" + i16 + "/reason",
                    schemaPath:
                      "#/properties/excluded/items/properties/reason/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err364];
                  } else {
                    vErrors.push(err364);
                  }
                  errors++;
                }
              } else {
                const err365 = {
                  instancePath: instancePath + "/excluded/" + i16 + "/reason",
                  schemaPath:
                    "#/properties/excluded/items/properties/reason/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err365];
                } else {
                  vErrors.push(err365);
                }
                errors++;
              }
            }
          } else {
            const err366 = {
              instancePath: instancePath + "/excluded/" + i16,
              schemaPath: "#/properties/excluded/items/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err366];
            } else {
              vErrors.push(err366);
            }
            errors++;
          }
        }
      } else {
        const err367 = {
          instancePath: instancePath + "/excluded",
          schemaPath: "#/properties/excluded/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err367];
        } else {
          vErrors.push(err367);
        }
        errors++;
      }
    }
    if (data.summary !== undefined) {
      let data154 = data.summary;
      if (data154 && typeof data154 == "object" && !Array.isArray(data154)) {
        if (data154.pre_existing === undefined) {
          const err368 = {
            instancePath: instancePath + "/summary",
            schemaPath: "#/properties/summary/required",
            keyword: "required",
            params: { missingProperty: "pre_existing" },
            message: "must have required property '" + "pre_existing" + "'",
          };
          if (vErrors === null) {
            vErrors = [err368];
          } else {
            vErrors.push(err368);
          }
          errors++;
        }
        if (data154.fixed === undefined) {
          const err369 = {
            instancePath: instancePath + "/summary",
            schemaPath: "#/properties/summary/required",
            keyword: "required",
            params: { missingProperty: "fixed" },
            message: "must have required property '" + "fixed" + "'",
          };
          if (vErrors === null) {
            vErrors = [err369];
          } else {
            vErrors.push(err369);
          }
          errors++;
        }
        if (data154.suppressed === undefined) {
          const err370 = {
            instancePath: instancePath + "/summary",
            schemaPath: "#/properties/summary/required",
            keyword: "required",
            params: { missingProperty: "suppressed" },
            message: "must have required property '" + "suppressed" + "'",
          };
          if (vErrors === null) {
            vErrors = [err370];
          } else {
            vErrors.push(err370);
          }
          errors++;
        }
        for (const key24 in data154) {
          if (!(
            key24 === "pre_existing" ||
            key24 === "fixed" ||
            key24 === "suppressed"
          )) {
            const err371 = {
              instancePath: instancePath + "/summary",
              schemaPath: "#/properties/summary/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key24 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err371];
            } else {
              vErrors.push(err371);
            }
            errors++;
          }
        }
        if (data154.pre_existing !== undefined) {
          let data155 = data154.pre_existing;
          if (!(
            typeof data155 == "number" &&
            !(data155 % 1) &&
            !isNaN(data155)
          )) {
            const err372 = {
              instancePath: instancePath + "/summary/pre_existing",
              schemaPath: "#/properties/summary/properties/pre_existing/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err372];
            } else {
              vErrors.push(err372);
            }
            errors++;
          }
          if (typeof data155 == "number") {
            if (data155 < 0 || isNaN(data155)) {
              const err373 = {
                instancePath: instancePath + "/summary/pre_existing",
                schemaPath:
                  "#/properties/summary/properties/pre_existing/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err373];
              } else {
                vErrors.push(err373);
              }
              errors++;
            }
          }
        }
        if (data154.fixed !== undefined) {
          let data156 = data154.fixed;
          if (!(
            typeof data156 == "number" &&
            !(data156 % 1) &&
            !isNaN(data156)
          )) {
            const err374 = {
              instancePath: instancePath + "/summary/fixed",
              schemaPath: "#/properties/summary/properties/fixed/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err374];
            } else {
              vErrors.push(err374);
            }
            errors++;
          }
          if (typeof data156 == "number") {
            if (data156 < 0 || isNaN(data156)) {
              const err375 = {
                instancePath: instancePath + "/summary/fixed",
                schemaPath: "#/properties/summary/properties/fixed/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err375];
              } else {
                vErrors.push(err375);
              }
              errors++;
            }
          }
        }
        if (data154.suppressed !== undefined) {
          let data157 = data154.suppressed;
          if (!(
            typeof data157 == "number" &&
            !(data157 % 1) &&
            !isNaN(data157)
          )) {
            const err376 = {
              instancePath: instancePath + "/summary/suppressed",
              schemaPath: "#/properties/summary/properties/suppressed/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err376];
            } else {
              vErrors.push(err376);
            }
            errors++;
          }
          if (typeof data157 == "number") {
            if (data157 < 0 || isNaN(data157)) {
              const err377 = {
                instancePath: instancePath + "/summary/suppressed",
                schemaPath:
                  "#/properties/summary/properties/suppressed/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err377];
              } else {
                vErrors.push(err377);
              }
              errors++;
            }
          }
        }
      } else {
        const err378 = {
          instancePath: instancePath + "/summary",
          schemaPath: "#/properties/summary/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err378];
        } else {
          vErrors.push(err378);
        }
        errors++;
      }
    }
    if (data.footer !== undefined) {
      let data158 = data.footer;
      if (data158 && typeof data158 == "object" && !Array.isArray(data158)) {
        if (data158.notes === undefined) {
          const err379 = {
            instancePath: instancePath + "/footer",
            schemaPath: "#/properties/footer/required",
            keyword: "required",
            params: { missingProperty: "notes" },
            message: "must have required property '" + "notes" + "'",
          };
          if (vErrors === null) {
            vErrors = [err379];
          } else {
            vErrors.push(err379);
          }
          errors++;
        }
        if (data158.suppressions === undefined) {
          const err380 = {
            instancePath: instancePath + "/footer",
            schemaPath: "#/properties/footer/required",
            keyword: "required",
            params: { missingProperty: "suppressions" },
            message: "must have required property '" + "suppressions" + "'",
          };
          if (vErrors === null) {
            vErrors = [err380];
          } else {
            vErrors.push(err380);
          }
          errors++;
        }
        if (data158.tool_versions === undefined) {
          const err381 = {
            instancePath: instancePath + "/footer",
            schemaPath: "#/properties/footer/required",
            keyword: "required",
            params: { missingProperty: "tool_versions" },
            message: "must have required property '" + "tool_versions" + "'",
          };
          if (vErrors === null) {
            vErrors = [err381];
          } else {
            vErrors.push(err381);
          }
          errors++;
        }
        for (const key25 in data158) {
          if (!(
            key25 === "notes" ||
            key25 === "suppressions" ||
            key25 === "tool_versions"
          )) {
            const err382 = {
              instancePath: instancePath + "/footer",
              schemaPath: "#/properties/footer/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key25 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err382];
            } else {
              vErrors.push(err382);
            }
            errors++;
          }
        }
        if (data158.notes !== undefined) {
          let data159 = data158.notes;
          if (Array.isArray(data159)) {
            const len17 = data159.length;
            for (let i17 = 0; i17 < len17; i17++) {
              let data160 = data159[i17];
              if (typeof data160 === "string") {
                if (func2(data160) < 1) {
                  const err383 = {
                    instancePath: instancePath + "/footer/notes/" + i17,
                    schemaPath:
                      "#/properties/footer/properties/notes/items/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err383];
                  } else {
                    vErrors.push(err383);
                  }
                  errors++;
                }
              } else {
                const err384 = {
                  instancePath: instancePath + "/footer/notes/" + i17,
                  schemaPath: "#/properties/footer/properties/notes/items/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err384];
                } else {
                  vErrors.push(err384);
                }
                errors++;
              }
            }
          } else {
            const err385 = {
              instancePath: instancePath + "/footer/notes",
              schemaPath: "#/properties/footer/properties/notes/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err385];
            } else {
              vErrors.push(err385);
            }
            errors++;
          }
        }
        if (data158.suppressions !== undefined) {
          let data161 = data158.suppressions;
          if (Array.isArray(data161)) {
            const len18 = data161.length;
            for (let i18 = 0; i18 < len18; i18++) {
              let data162 = data161[i18];
              if (
                data162 &&
                typeof data162 == "object" &&
                !Array.isArray(data162)
              ) {
                if (data162.entry === undefined) {
                  const err386 = {
                    instancePath: instancePath + "/footer/suppressions/" + i18,
                    schemaPath:
                      "#/properties/footer/properties/suppressions/items/required",
                    keyword: "required",
                    params: { missingProperty: "entry" },
                    message: "must have required property '" + "entry" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err386];
                  } else {
                    vErrors.push(err386);
                  }
                  errors++;
                }
                if (data162.count === undefined) {
                  const err387 = {
                    instancePath: instancePath + "/footer/suppressions/" + i18,
                    schemaPath:
                      "#/properties/footer/properties/suppressions/items/required",
                    keyword: "required",
                    params: { missingProperty: "count" },
                    message: "must have required property '" + "count" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err387];
                  } else {
                    vErrors.push(err387);
                  }
                  errors++;
                }
                for (const key26 in data162) {
                  if (!(key26 === "entry" || key26 === "count")) {
                    const err388 = {
                      instancePath:
                        instancePath + "/footer/suppressions/" + i18,
                      schemaPath:
                        "#/properties/footer/properties/suppressions/items/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key26 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err388];
                    } else {
                      vErrors.push(err388);
                    }
                    errors++;
                  }
                }
                if (data162.entry !== undefined) {
                  let data163 = data162.entry;
                  if (!(
                    typeof data163 == "number" &&
                    !(data163 % 1) &&
                    !isNaN(data163)
                  )) {
                    const err389 = {
                      instancePath:
                        instancePath + "/footer/suppressions/" + i18 + "/entry",
                      schemaPath:
                        "#/properties/footer/properties/suppressions/items/properties/entry/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err389];
                    } else {
                      vErrors.push(err389);
                    }
                    errors++;
                  }
                  if (typeof data163 == "number") {
                    if (data163 < 0 || isNaN(data163)) {
                      const err390 = {
                        instancePath:
                          instancePath +
                          "/footer/suppressions/" +
                          i18 +
                          "/entry",
                        schemaPath:
                          "#/properties/footer/properties/suppressions/items/properties/entry/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 0 },
                        message: "must be >= 0",
                      };
                      if (vErrors === null) {
                        vErrors = [err390];
                      } else {
                        vErrors.push(err390);
                      }
                      errors++;
                    }
                  }
                }
                if (data162.count !== undefined) {
                  let data164 = data162.count;
                  if (!(
                    typeof data164 == "number" &&
                    !(data164 % 1) &&
                    !isNaN(data164)
                  )) {
                    const err391 = {
                      instancePath:
                        instancePath + "/footer/suppressions/" + i18 + "/count",
                      schemaPath:
                        "#/properties/footer/properties/suppressions/items/properties/count/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err391];
                    } else {
                      vErrors.push(err391);
                    }
                    errors++;
                  }
                  if (typeof data164 == "number") {
                    if (data164 < 0 || isNaN(data164)) {
                      const err392 = {
                        instancePath:
                          instancePath +
                          "/footer/suppressions/" +
                          i18 +
                          "/count",
                        schemaPath:
                          "#/properties/footer/properties/suppressions/items/properties/count/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 0 },
                        message: "must be >= 0",
                      };
                      if (vErrors === null) {
                        vErrors = [err392];
                      } else {
                        vErrors.push(err392);
                      }
                      errors++;
                    }
                  }
                }
              } else {
                const err393 = {
                  instancePath: instancePath + "/footer/suppressions/" + i18,
                  schemaPath:
                    "#/properties/footer/properties/suppressions/items/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err393];
                } else {
                  vErrors.push(err393);
                }
                errors++;
              }
            }
          } else {
            const err394 = {
              instancePath: instancePath + "/footer/suppressions",
              schemaPath: "#/properties/footer/properties/suppressions/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err394];
            } else {
              vErrors.push(err394);
            }
            errors++;
          }
        }
        if (data158.tool_versions !== undefined) {
          let data165 = data158.tool_versions;
          if (
            data165 &&
            typeof data165 == "object" &&
            !Array.isArray(data165)
          ) {
            for (const key27 in data165) {
              let data166 = data165[key27];
              if (typeof data166 === "string") {
                if (func2(data166) < 1) {
                  const err395 = {
                    instancePath:
                      instancePath +
                      "/footer/tool_versions/" +
                      key27.replace(/~/g, "~0").replace(/\//g, "~1"),
                    schemaPath:
                      "#/properties/footer/properties/tool_versions/additionalProperties/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err395];
                  } else {
                    vErrors.push(err395);
                  }
                  errors++;
                }
              } else {
                const err396 = {
                  instancePath:
                    instancePath +
                    "/footer/tool_versions/" +
                    key27.replace(/~/g, "~0").replace(/\//g, "~1"),
                  schemaPath:
                    "#/properties/footer/properties/tool_versions/additionalProperties/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err396];
                } else {
                  vErrors.push(err396);
                }
                errors++;
              }
            }
          } else {
            const err397 = {
              instancePath: instancePath + "/footer/tool_versions",
              schemaPath: "#/properties/footer/properties/tool_versions/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err397];
            } else {
              vErrors.push(err397);
            }
            errors++;
          }
        }
      } else {
        const err398 = {
          instancePath: instancePath + "/footer",
          schemaPath: "#/properties/footer/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err398];
        } else {
          vErrors.push(err398);
        }
        errors++;
      }
    }
    if (data.metrics !== undefined) {
      let data167 = data.metrics;
      if (data167 && typeof data167 == "object" && !Array.isArray(data167)) {
        if (data167.wall_time_ms === undefined) {
          const err399 = {
            instancePath: instancePath + "/metrics",
            schemaPath: "#/properties/metrics/required",
            keyword: "required",
            params: { missingProperty: "wall_time_ms" },
            message: "must have required property '" + "wall_time_ms" + "'",
          };
          if (vErrors === null) {
            vErrors = [err399];
          } else {
            vErrors.push(err399);
          }
          errors++;
        }
        if (data167.checks === undefined) {
          const err400 = {
            instancePath: instancePath + "/metrics",
            schemaPath: "#/properties/metrics/required",
            keyword: "required",
            params: { missingProperty: "checks" },
            message: "must have required property '" + "checks" + "'",
          };
          if (vErrors === null) {
            vErrors = [err400];
          } else {
            vErrors.push(err400);
          }
          errors++;
        }
        if (data167.tool_versions === undefined) {
          const err401 = {
            instancePath: instancePath + "/metrics",
            schemaPath: "#/properties/metrics/required",
            keyword: "required",
            params: { missingProperty: "tool_versions" },
            message: "must have required property '" + "tool_versions" + "'",
          };
          if (vErrors === null) {
            vErrors = [err401];
          } else {
            vErrors.push(err401);
          }
          errors++;
        }
        for (const key28 in data167) {
          if (!(
            key28 === "wall_time_ms" ||
            key28 === "checks" ||
            key28 === "tool_versions"
          )) {
            const err402 = {
              instancePath: instancePath + "/metrics",
              schemaPath: "#/properties/metrics/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key28 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err402];
            } else {
              vErrors.push(err402);
            }
            errors++;
          }
        }
        if (data167.wall_time_ms !== undefined) {
          let data168 = data167.wall_time_ms;
          if (!(
            typeof data168 == "number" &&
            !(data168 % 1) &&
            !isNaN(data168)
          )) {
            const err403 = {
              instancePath: instancePath + "/metrics/wall_time_ms",
              schemaPath: "#/properties/metrics/properties/wall_time_ms/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err403];
            } else {
              vErrors.push(err403);
            }
            errors++;
          }
          if (typeof data168 == "number") {
            if (data168 < 0 || isNaN(data168)) {
              const err404 = {
                instancePath: instancePath + "/metrics/wall_time_ms",
                schemaPath:
                  "#/properties/metrics/properties/wall_time_ms/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err404];
              } else {
                vErrors.push(err404);
              }
              errors++;
            }
          }
        }
        if (data167.checks !== undefined) {
          let data169 = data167.checks;
          if (Array.isArray(data169)) {
            const len19 = data169.length;
            for (let i19 = 0; i19 < len19; i19++) {
              let data170 = data169[i19];
              if (
                data170 &&
                typeof data170 == "object" &&
                !Array.isArray(data170)
              ) {
                if (data170.kind === undefined) {
                  const err405 = {
                    instancePath: instancePath + "/metrics/checks/" + i19,
                    schemaPath:
                      "#/properties/metrics/properties/checks/items/required",
                    keyword: "required",
                    params: { missingProperty: "kind" },
                    message: "must have required property '" + "kind" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err405];
                  } else {
                    vErrors.push(err405);
                  }
                  errors++;
                }
                if (data170.root === undefined) {
                  const err406 = {
                    instancePath: instancePath + "/metrics/checks/" + i19,
                    schemaPath:
                      "#/properties/metrics/properties/checks/items/required",
                    keyword: "required",
                    params: { missingProperty: "root" },
                    message: "must have required property '" + "root" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err406];
                  } else {
                    vErrors.push(err406);
                  }
                  errors++;
                }
                if (data170.version === undefined) {
                  const err407 = {
                    instancePath: instancePath + "/metrics/checks/" + i19,
                    schemaPath:
                      "#/properties/metrics/properties/checks/items/required",
                    keyword: "required",
                    params: { missingProperty: "version" },
                    message: "must have required property '" + "version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err407];
                  } else {
                    vErrors.push(err407);
                  }
                  errors++;
                }
                if (data170.wall_time_ms === undefined) {
                  const err408 = {
                    instancePath: instancePath + "/metrics/checks/" + i19,
                    schemaPath:
                      "#/properties/metrics/properties/checks/items/required",
                    keyword: "required",
                    params: { missingProperty: "wall_time_ms" },
                    message:
                      "must have required property '" + "wall_time_ms" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err408];
                  } else {
                    vErrors.push(err408);
                  }
                  errors++;
                }
                for (const key29 in data170) {
                  if (!(
                    key29 === "kind" ||
                    key29 === "root" ||
                    key29 === "version" ||
                    key29 === "wall_time_ms"
                  )) {
                    const err409 = {
                      instancePath: instancePath + "/metrics/checks/" + i19,
                      schemaPath:
                        "#/properties/metrics/properties/checks/items/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key29 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err409];
                    } else {
                      vErrors.push(err409);
                    }
                    errors++;
                  }
                }
                if (data170.kind !== undefined) {
                  let data171 = data170.kind;
                  if (!(
                    data171 === "typecheck" ||
                    data171 === "lint" ||
                    data171 === "secrets" ||
                    data171 === "coverage" ||
                    data171 === "dependencies"
                  )) {
                    const err410 = {
                      instancePath:
                        instancePath + "/metrics/checks/" + i19 + "/kind",
                      schemaPath:
                        "#/properties/metrics/properties/checks/items/properties/kind/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema32.properties.metrics.properties.checks.items
                            .properties.kind.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err410];
                    } else {
                      vErrors.push(err410);
                    }
                    errors++;
                  }
                }
                if (data170.root !== undefined) {
                  let data172 = data170.root;
                  if (typeof data172 === "string") {
                    if (func2(data172) < 1) {
                      const err411 = {
                        instancePath:
                          instancePath + "/metrics/checks/" + i19 + "/root",
                        schemaPath:
                          "#/properties/metrics/properties/checks/items/properties/root/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err411];
                      } else {
                        vErrors.push(err411);
                      }
                      errors++;
                    }
                  } else {
                    const err412 = {
                      instancePath:
                        instancePath + "/metrics/checks/" + i19 + "/root",
                      schemaPath:
                        "#/properties/metrics/properties/checks/items/properties/root/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err412];
                    } else {
                      vErrors.push(err412);
                    }
                    errors++;
                  }
                }
                if (data170.version !== undefined) {
                  let data173 = data170.version;
                  if (!(data173 === "base" || data173 === "head")) {
                    const err413 = {
                      instancePath:
                        instancePath + "/metrics/checks/" + i19 + "/version",
                      schemaPath:
                        "#/properties/metrics/properties/checks/items/properties/version/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema32.properties.metrics.properties.checks.items
                            .properties.version.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err413];
                    } else {
                      vErrors.push(err413);
                    }
                    errors++;
                  }
                }
                if (data170.wall_time_ms !== undefined) {
                  let data174 = data170.wall_time_ms;
                  if (!(
                    typeof data174 == "number" &&
                    !(data174 % 1) &&
                    !isNaN(data174)
                  )) {
                    const err414 = {
                      instancePath:
                        instancePath +
                        "/metrics/checks/" +
                        i19 +
                        "/wall_time_ms",
                      schemaPath:
                        "#/properties/metrics/properties/checks/items/properties/wall_time_ms/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err414];
                    } else {
                      vErrors.push(err414);
                    }
                    errors++;
                  }
                  if (typeof data174 == "number") {
                    if (data174 < 0 || isNaN(data174)) {
                      const err415 = {
                        instancePath:
                          instancePath +
                          "/metrics/checks/" +
                          i19 +
                          "/wall_time_ms",
                        schemaPath:
                          "#/properties/metrics/properties/checks/items/properties/wall_time_ms/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 0 },
                        message: "must be >= 0",
                      };
                      if (vErrors === null) {
                        vErrors = [err415];
                      } else {
                        vErrors.push(err415);
                      }
                      errors++;
                    }
                  }
                }
              } else {
                const err416 = {
                  instancePath: instancePath + "/metrics/checks/" + i19,
                  schemaPath:
                    "#/properties/metrics/properties/checks/items/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err416];
                } else {
                  vErrors.push(err416);
                }
                errors++;
              }
            }
          } else {
            const err417 = {
              instancePath: instancePath + "/metrics/checks",
              schemaPath: "#/properties/metrics/properties/checks/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err417];
            } else {
              vErrors.push(err417);
            }
            errors++;
          }
        }
        if (data167.tool_versions !== undefined) {
          let data175 = data167.tool_versions;
          if (
            data175 &&
            typeof data175 == "object" &&
            !Array.isArray(data175)
          ) {
            for (const key30 in data175) {
              let data176 = data175[key30];
              if (typeof data176 === "string") {
                if (func2(data176) < 1) {
                  const err418 = {
                    instancePath:
                      instancePath +
                      "/metrics/tool_versions/" +
                      key30.replace(/~/g, "~0").replace(/\//g, "~1"),
                    schemaPath:
                      "#/properties/metrics/properties/tool_versions/additionalProperties/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err418];
                  } else {
                    vErrors.push(err418);
                  }
                  errors++;
                }
              } else {
                const err419 = {
                  instancePath:
                    instancePath +
                    "/metrics/tool_versions/" +
                    key30.replace(/~/g, "~0").replace(/\//g, "~1"),
                  schemaPath:
                    "#/properties/metrics/properties/tool_versions/additionalProperties/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err419];
                } else {
                  vErrors.push(err419);
                }
                errors++;
              }
            }
          } else {
            const err420 = {
              instancePath: instancePath + "/metrics/tool_versions",
              schemaPath: "#/properties/metrics/properties/tool_versions/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err420];
            } else {
              vErrors.push(err420);
            }
            errors++;
          }
        }
      } else {
        const err421 = {
          instancePath: instancePath + "/metrics",
          schemaPath: "#/properties/metrics/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err421];
        } else {
          vErrors.push(err421);
        }
        errors++;
      }
    }
    if (data.error !== undefined) {
      let data177 = data.error;
      if (data177 && typeof data177 == "object" && !Array.isArray(data177)) {
        if (data177.code === undefined) {
          const err422 = {
            instancePath: instancePath + "/error",
            schemaPath: "#/properties/error/required",
            keyword: "required",
            params: { missingProperty: "code" },
            message: "must have required property '" + "code" + "'",
          };
          if (vErrors === null) {
            vErrors = [err422];
          } else {
            vErrors.push(err422);
          }
          errors++;
        }
        if (data177.message === undefined) {
          const err423 = {
            instancePath: instancePath + "/error",
            schemaPath: "#/properties/error/required",
            keyword: "required",
            params: { missingProperty: "message" },
            message: "must have required property '" + "message" + "'",
          };
          if (vErrors === null) {
            vErrors = [err423];
          } else {
            vErrors.push(err423);
          }
          errors++;
        }
        if (data177.details === undefined) {
          const err424 = {
            instancePath: instancePath + "/error",
            schemaPath: "#/properties/error/required",
            keyword: "required",
            params: { missingProperty: "details" },
            message: "must have required property '" + "details" + "'",
          };
          if (vErrors === null) {
            vErrors = [err424];
          } else {
            vErrors.push(err424);
          }
          errors++;
        }
        for (const key31 in data177) {
          if (!(
            key31 === "code" ||
            key31 === "message" ||
            key31 === "details"
          )) {
            const err425 = {
              instancePath: instancePath + "/error",
              schemaPath: "#/properties/error/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key31 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err425];
            } else {
              vErrors.push(err425);
            }
            errors++;
          }
        }
        if (data177.code !== undefined) {
          let data178 = data177.code;
          if (typeof data178 === "string") {
            if (func2(data178) < 1) {
              const err426 = {
                instancePath: instancePath + "/error/code",
                schemaPath: "#/properties/error/properties/code/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err426];
              } else {
                vErrors.push(err426);
              }
              errors++;
            }
          } else {
            const err427 = {
              instancePath: instancePath + "/error/code",
              schemaPath: "#/properties/error/properties/code/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err427];
            } else {
              vErrors.push(err427);
            }
            errors++;
          }
        }
        if (data177.message !== undefined) {
          let data179 = data177.message;
          if (typeof data179 === "string") {
            if (func2(data179) < 1) {
              const err428 = {
                instancePath: instancePath + "/error/message",
                schemaPath: "#/properties/error/properties/message/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err428];
              } else {
                vErrors.push(err428);
              }
              errors++;
            }
          } else {
            const err429 = {
              instancePath: instancePath + "/error/message",
              schemaPath: "#/properties/error/properties/message/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err429];
            } else {
              vErrors.push(err429);
            }
            errors++;
          }
        }
        if (data177.details !== undefined) {
          let data180 = data177.details;
          if (Array.isArray(data180)) {
            const len20 = data180.length;
            for (let i20 = 0; i20 < len20; i20++) {
              if (typeof data180[i20] !== "string") {
                const err430 = {
                  instancePath: instancePath + "/error/details/" + i20,
                  schemaPath:
                    "#/properties/error/properties/details/items/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err430];
                } else {
                  vErrors.push(err430);
                }
                errors++;
              }
            }
          } else {
            const err431 = {
              instancePath: instancePath + "/error/details",
              schemaPath: "#/properties/error/properties/details/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err431];
            } else {
              vErrors.push(err431);
            }
            errors++;
          }
        }
      } else {
        const err432 = {
          instancePath: instancePath + "/error",
          schemaPath: "#/properties/error/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err432];
        } else {
          vErrors.push(err432);
        }
        errors++;
      }
    }
    if (data.risk_tier !== undefined) {
      let data182 = data.risk_tier;
      const _errs392 = errors;
      let valid88 = false;
      let passing2 = null;
      const _errs393 = errors;
      if (data182 !== null) {
        const err433 = {
          instancePath: instancePath + "/risk_tier",
          schemaPath: "#/properties/risk_tier/oneOf/0/type",
          keyword: "type",
          params: { type: "null" },
          message: "must be null",
        };
        if (vErrors === null) {
          vErrors = [err433];
        } else {
          vErrors.push(err433);
        }
        errors++;
      }
      var _valid5 = _errs393 === errors;
      if (_valid5) {
        valid88 = true;
        passing2 = 0;
      }
      const _errs395 = errors;
      if (data182 && typeof data182 == "object" && !Array.isArray(data182)) {
        if (data182.tier === undefined) {
          const err434 = {
            instancePath: instancePath + "/risk_tier",
            schemaPath: "#/properties/risk_tier/oneOf/1/required",
            keyword: "required",
            params: { missingProperty: "tier" },
            message: "must have required property '" + "tier" + "'",
          };
          if (vErrors === null) {
            vErrors = [err434];
          } else {
            vErrors.push(err434);
          }
          errors++;
        }
        if (data182.reasons === undefined) {
          const err435 = {
            instancePath: instancePath + "/risk_tier",
            schemaPath: "#/properties/risk_tier/oneOf/1/required",
            keyword: "required",
            params: { missingProperty: "reasons" },
            message: "must have required property '" + "reasons" + "'",
          };
          if (vErrors === null) {
            vErrors = [err435];
          } else {
            vErrors.push(err435);
          }
          errors++;
        }
        if (data182.source === undefined) {
          const err436 = {
            instancePath: instancePath + "/risk_tier",
            schemaPath: "#/properties/risk_tier/oneOf/1/required",
            keyword: "required",
            params: { missingProperty: "source" },
            message: "must have required property '" + "source" + "'",
          };
          if (vErrors === null) {
            vErrors = [err436];
          } else {
            vErrors.push(err436);
          }
          errors++;
        }
        for (const key32 in data182) {
          if (!(
            key32 === "tier" ||
            key32 === "reasons" ||
            key32 === "source"
          )) {
            const err437 = {
              instancePath: instancePath + "/risk_tier",
              schemaPath: "#/properties/risk_tier/oneOf/1/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key32 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err437];
            } else {
              vErrors.push(err437);
            }
            errors++;
          }
        }
        if (data182.tier !== undefined) {
          let data183 = data182.tier;
          if (!(
            data183 === "low" ||
            data183 === "medium" ||
            data183 === "high"
          )) {
            const err438 = {
              instancePath: instancePath + "/risk_tier/tier",
              schemaPath: "#/properties/risk_tier/oneOf/1/properties/tier/enum",
              keyword: "enum",
              params: {
                allowedValues:
                  schema32.properties.risk_tier.oneOf[1].properties.tier.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err438];
            } else {
              vErrors.push(err438);
            }
            errors++;
          }
        }
        if (data182.reasons !== undefined) {
          let data184 = data182.reasons;
          if (Array.isArray(data184)) {
            const len21 = data184.length;
            for (let i21 = 0; i21 < len21; i21++) {
              if (typeof data184[i21] !== "string") {
                const err439 = {
                  instancePath: instancePath + "/risk_tier/reasons/" + i21,
                  schemaPath:
                    "#/properties/risk_tier/oneOf/1/properties/reasons/items/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err439];
                } else {
                  vErrors.push(err439);
                }
                errors++;
              }
            }
          } else {
            const err440 = {
              instancePath: instancePath + "/risk_tier/reasons",
              schemaPath:
                "#/properties/risk_tier/oneOf/1/properties/reasons/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err440];
            } else {
              vErrors.push(err440);
            }
            errors++;
          }
        }
        if (data182.source !== undefined) {
          let data186 = data182.source;
          if (!(data186 === "always_human" || data186 === "triage")) {
            const err441 = {
              instancePath: instancePath + "/risk_tier/source",
              schemaPath:
                "#/properties/risk_tier/oneOf/1/properties/source/enum",
              keyword: "enum",
              params: {
                allowedValues:
                  schema32.properties.risk_tier.oneOf[1].properties.source.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err441];
            } else {
              vErrors.push(err441);
            }
            errors++;
          }
        }
      } else {
        const err442 = {
          instancePath: instancePath + "/risk_tier",
          schemaPath: "#/properties/risk_tier/oneOf/1/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err442];
        } else {
          vErrors.push(err442);
        }
        errors++;
      }
      var _valid5 = _errs395 === errors;
      if (_valid5 && valid88) {
        valid88 = false;
        passing2 = [passing2, 1];
      } else {
        if (_valid5) {
          valid88 = true;
          passing2 = 1;
        }
      }
      if (!valid88) {
        const err443 = {
          instancePath: instancePath + "/risk_tier",
          schemaPath: "#/properties/risk_tier/oneOf",
          keyword: "oneOf",
          params: { passingSchemas: passing2 },
          message: "must match exactly one schema in oneOf",
        };
        if (vErrors === null) {
          vErrors = [err443];
        } else {
          vErrors.push(err443);
        }
        errors++;
      } else {
        errors = _errs392;
        if (vErrors !== null) {
          if (_errs392) {
            vErrors.length = _errs392;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.security !== undefined) {
      let data187 = data.security;
      if (Array.isArray(data187)) {
        const len22 = data187.length;
        for (let i22 = 0; i22 < len22; i22++) {
          let data188 = data187[i22];
          const _errs410 = errors;
          let valid96 = true;
          const _errs411 = errors;
          if (
            data188 &&
            typeof data188 == "object" &&
            !Array.isArray(data188)
          ) {
            if (data188.rule_id !== undefined) {
              let data189 = data188.rule_id;
              if (typeof data189 === "string") {
                if (!pattern6.test(data189)) {
                  const err444 = {};
                  if (vErrors === null) {
                    vErrors = [err444];
                  } else {
                    vErrors.push(err444);
                  }
                  errors++;
                }
              }
            }
          }
          var _valid6 = _errs411 === errors;
          errors = _errs410;
          if (vErrors !== null) {
            if (_errs410) {
              vErrors.length = _errs410;
            } else {
              vErrors = null;
            }
          }
          if (_valid6) {
            const _errs413 = errors;
            if (
              data188 &&
              typeof data188 == "object" &&
              !Array.isArray(data188)
            ) {
              if (data188.advisory === undefined) {
                const err445 = {
                  instancePath: instancePath + "/security/" + i22,
                  schemaPath: "#/$defs/finding/allOf/0/then/required",
                  keyword: "required",
                  params: { missingProperty: "advisory" },
                  message: "must have required property '" + "advisory" + "'",
                };
                if (vErrors === null) {
                  vErrors = [err445];
                } else {
                  vErrors.push(err445);
                }
                errors++;
              }
            }
            var _valid6 = _errs413 === errors;
            valid96 = _valid6;
          }
          if (!valid96) {
            const err446 = {
              instancePath: instancePath + "/security/" + i22,
              schemaPath: "#/$defs/finding/allOf/0/if",
              keyword: "if",
              params: { failingKeyword: "then" },
              message: 'must match "then" schema',
            };
            if (vErrors === null) {
              vErrors = [err446];
            } else {
              vErrors.push(err446);
            }
            errors++;
          }
          if (
            data188 &&
            typeof data188 == "object" &&
            !Array.isArray(data188)
          ) {
            if (data188.id === undefined) {
              const err447 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "id" },
                message: "must have required property '" + "id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err447];
              } else {
                vErrors.push(err447);
              }
              errors++;
            }
            if (data188.rule_id === undefined) {
              const err448 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "rule_id" },
                message: "must have required property '" + "rule_id" + "'",
              };
              if (vErrors === null) {
                vErrors = [err448];
              } else {
                vErrors.push(err448);
              }
              errors++;
            }
            if (data188.category === undefined) {
              const err449 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "category" },
                message: "must have required property '" + "category" + "'",
              };
              if (vErrors === null) {
                vErrors = [err449];
              } else {
                vErrors.push(err449);
              }
              errors++;
            }
            if (data188.evidence_level === undefined) {
              const err450 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "evidence_level" },
                message:
                  "must have required property '" + "evidence_level" + "'",
              };
              if (vErrors === null) {
                vErrors = [err450];
              } else {
                vErrors.push(err450);
              }
              errors++;
            }
            if (data188.severity === undefined) {
              const err451 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "severity" },
                message: "must have required property '" + "severity" + "'",
              };
              if (vErrors === null) {
                vErrors = [err451];
              } else {
                vErrors.push(err451);
              }
              errors++;
            }
            if (data188.state === undefined) {
              const err452 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "state" },
                message: "must have required property '" + "state" + "'",
              };
              if (vErrors === null) {
                vErrors = [err452];
              } else {
                vErrors.push(err452);
              }
              errors++;
            }
            if (data188.location === undefined) {
              const err453 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "location" },
                message: "must have required property '" + "location" + "'",
              };
              if (vErrors === null) {
                vErrors = [err453];
              } else {
                vErrors.push(err453);
              }
              errors++;
            }
            if (data188.message === undefined) {
              const err454 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "message" },
                message: "must have required property '" + "message" + "'",
              };
              if (vErrors === null) {
                vErrors = [err454];
              } else {
                vErrors.push(err454);
              }
              errors++;
            }
            if (data188.trigger === undefined) {
              const err455 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "trigger" },
                message: "must have required property '" + "trigger" + "'",
              };
              if (vErrors === null) {
                vErrors = [err455];
              } else {
                vErrors.push(err455);
              }
              errors++;
            }
            if (data188.evidence === undefined) {
              const err456 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "evidence" },
                message: "must have required property '" + "evidence" + "'",
              };
              if (vErrors === null) {
                vErrors = [err456];
              } else {
                vErrors.push(err456);
              }
              errors++;
            }
            if (data188.source === undefined) {
              const err457 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "source" },
                message: "must have required property '" + "source" + "'",
              };
              if (vErrors === null) {
                vErrors = [err457];
              } else {
                vErrors.push(err457);
              }
              errors++;
            }
            if (data188.locations === undefined) {
              const err458 = {
                instancePath: instancePath + "/security/" + i22,
                schemaPath: "#/$defs/finding/required",
                keyword: "required",
                params: { missingProperty: "locations" },
                message: "must have required property '" + "locations" + "'",
              };
              if (vErrors === null) {
                vErrors = [err458];
              } else {
                vErrors.push(err458);
              }
              errors++;
            }
            for (const key33 in data188) {
              if (!func1.call(schema34.properties, key33)) {
                const err459 = {
                  instancePath: instancePath + "/security/" + i22,
                  schemaPath: "#/$defs/finding/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key33 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err459];
                } else {
                  vErrors.push(err459);
                }
                errors++;
              }
            }
            if (data188.id !== undefined) {
              let data190 = data188.id;
              if (typeof data190 === "string") {
                if (!pattern7.test(data190)) {
                  const err460 = {
                    instancePath: instancePath + "/security/" + i22 + "/id",
                    schemaPath: "#/$defs/finding/properties/id/pattern",
                    keyword: "pattern",
                    params: { pattern: "^[a-f0-9]{64}$" },
                    message: 'must match pattern "' + "^[a-f0-9]{64}$" + '"',
                  };
                  if (vErrors === null) {
                    vErrors = [err460];
                  } else {
                    vErrors.push(err460);
                  }
                  errors++;
                }
              } else {
                const err461 = {
                  instancePath: instancePath + "/security/" + i22 + "/id",
                  schemaPath: "#/$defs/finding/properties/id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err461];
                } else {
                  vErrors.push(err461);
                }
                errors++;
              }
            }
            if (data188.rule_id !== undefined) {
              let data191 = data188.rule_id;
              if (typeof data191 === "string") {
                if (func2(data191) < 1) {
                  const err462 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/rule_id",
                    schemaPath: "#/$defs/finding/properties/rule_id/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err462];
                  } else {
                    vErrors.push(err462);
                  }
                  errors++;
                }
              } else {
                const err463 = {
                  instancePath: instancePath + "/security/" + i22 + "/rule_id",
                  schemaPath: "#/$defs/finding/properties/rule_id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err463];
                } else {
                  vErrors.push(err463);
                }
                errors++;
              }
            }
            if (data188.category !== undefined) {
              let data192 = data188.category;
              if (!(
                data192 === "defect" ||
                data192 === "risk" ||
                data192 === "security"
              )) {
                const err464 = {
                  instancePath: instancePath + "/security/" + i22 + "/category",
                  schemaPath: "#/$defs/finding/properties/category/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.category.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err464];
                } else {
                  vErrors.push(err464);
                }
                errors++;
              }
            }
            if (data188.evidence_level !== undefined) {
              let data193 = data188.evidence_level;
              if (!(
                data193 === "reproduced" ||
                data193 === "static_proven" ||
                data193 === "plausible" ||
                data193 === "refuted"
              )) {
                const err465 = {
                  instancePath:
                    instancePath + "/security/" + i22 + "/evidence_level",
                  schemaPath: "#/$defs/finding/properties/evidence_level/enum",
                  keyword: "enum",
                  params: {
                    allowedValues: schema34.properties.evidence_level.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err465];
                } else {
                  vErrors.push(err465);
                }
                errors++;
              }
            }
            if (data188.severity !== undefined) {
              let data194 = data188.severity;
              if (!(
                data194 === "error" ||
                data194 === "warning" ||
                data194 === "info"
              )) {
                const err466 = {
                  instancePath: instancePath + "/security/" + i22 + "/severity",
                  schemaPath: "#/$defs/finding/properties/severity/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.severity.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err466];
                } else {
                  vErrors.push(err466);
                }
                errors++;
              }
            }
            if (data188.state !== undefined) {
              let data195 = data188.state;
              if (!(
                data195 === "new" ||
                data195 === "worsened" ||
                data195 === "pre-existing" ||
                data195 === "fixed" ||
                data195 === "unclassified"
              )) {
                const err467 = {
                  instancePath: instancePath + "/security/" + i22 + "/state",
                  schemaPath: "#/$defs/finding/properties/state/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.state.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err467];
                } else {
                  vErrors.push(err467);
                }
                errors++;
              }
            }
            if (data188.location !== undefined) {
              let data196 = data188.location;
              if (
                data196 &&
                typeof data196 == "object" &&
                !Array.isArray(data196)
              ) {
                if (data196.path === undefined) {
                  const err468 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "path" },
                    message: "must have required property '" + "path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err468];
                  } else {
                    vErrors.push(err468);
                  }
                  errors++;
                }
                if (data196.line_start === undefined) {
                  const err469 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "line_start" },
                    message:
                      "must have required property '" + "line_start" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err469];
                  } else {
                    vErrors.push(err469);
                  }
                  errors++;
                }
                if (data196.line_end === undefined) {
                  const err470 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "line_end" },
                    message: "must have required property '" + "line_end" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err470];
                  } else {
                    vErrors.push(err470);
                  }
                  errors++;
                }
                if (data196.symbol_path === undefined) {
                  const err471 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "symbol_path" },
                    message:
                      "must have required property '" + "symbol_path" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err471];
                  } else {
                    vErrors.push(err471);
                  }
                  errors++;
                }
                if (data196.occurrence_state === undefined) {
                  const err472 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/location",
                    schemaPath: "#/$defs/finding/properties/location/required",
                    keyword: "required",
                    params: { missingProperty: "occurrence_state" },
                    message:
                      "must have required property '" +
                      "occurrence_state" +
                      "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err472];
                  } else {
                    vErrors.push(err472);
                  }
                  errors++;
                }
                for (const key34 in data196) {
                  if (!(
                    key34 === "path" ||
                    key34 === "line_start" ||
                    key34 === "line_end" ||
                    key34 === "column" ||
                    key34 === "symbol_path" ||
                    key34 === "occurrence_state"
                  )) {
                    const err473 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/location",
                      schemaPath:
                        "#/$defs/finding/properties/location/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key34 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err473];
                    } else {
                      vErrors.push(err473);
                    }
                    errors++;
                  }
                }
                if (data196.path !== undefined) {
                  let data197 = data196.path;
                  if (typeof data197 === "string") {
                    if (func2(data197) < 1) {
                      const err474 = {
                        instancePath:
                          instancePath + "/security/" + i22 + "/location/path",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/path/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err474];
                      } else {
                        vErrors.push(err474);
                      }
                      errors++;
                    }
                    if (!pattern8.test(data197)) {
                      const err475 = {
                        instancePath:
                          instancePath + "/security/" + i22 + "/location/path",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/path/pattern",
                        keyword: "pattern",
                        params: {
                          pattern:
                            "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                        },
                        message:
                          'must match pattern "' +
                          "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                          '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err475];
                      } else {
                        vErrors.push(err475);
                      }
                      errors++;
                    }
                  } else {
                    const err476 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/location/path",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err476];
                    } else {
                      vErrors.push(err476);
                    }
                    errors++;
                  }
                }
                if (data196.line_start !== undefined) {
                  let data198 = data196.line_start;
                  if (!(
                    typeof data198 == "number" &&
                    !(data198 % 1) &&
                    !isNaN(data198)
                  )) {
                    const err477 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/location/line_start",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/line_start/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err477];
                    } else {
                      vErrors.push(err477);
                    }
                    errors++;
                  }
                  if (typeof data198 == "number") {
                    if (data198 < 1 || isNaN(data198)) {
                      const err478 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/location/line_start",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/line_start/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err478];
                      } else {
                        vErrors.push(err478);
                      }
                      errors++;
                    }
                  }
                }
                if (data196.line_end !== undefined) {
                  let data199 = data196.line_end;
                  if (!(
                    typeof data199 == "number" &&
                    !(data199 % 1) &&
                    !isNaN(data199)
                  )) {
                    const err479 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/location/line_end",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/line_end/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err479];
                    } else {
                      vErrors.push(err479);
                    }
                    errors++;
                  }
                  if (typeof data199 == "number") {
                    if (data199 < 1 || isNaN(data199)) {
                      const err480 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/location/line_end",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/line_end/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err480];
                      } else {
                        vErrors.push(err480);
                      }
                      errors++;
                    }
                  }
                }
                if (data196.column !== undefined) {
                  let data200 = data196.column;
                  if (!(
                    typeof data200 == "number" &&
                    !(data200 % 1) &&
                    !isNaN(data200)
                  )) {
                    const err481 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/location/column",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/column/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err481];
                    } else {
                      vErrors.push(err481);
                    }
                    errors++;
                  }
                  if (typeof data200 == "number") {
                    if (data200 < 1 || isNaN(data200)) {
                      const err482 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/location/column",
                        schemaPath:
                          "#/$defs/finding/properties/location/properties/column/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err482];
                      } else {
                        vErrors.push(err482);
                      }
                      errors++;
                    }
                  }
                }
                if (data196.symbol_path !== undefined) {
                  if (typeof data196.symbol_path !== "string") {
                    const err483 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/location/symbol_path",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/symbol_path/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err483];
                    } else {
                      vErrors.push(err483);
                    }
                    errors++;
                  }
                }
                if (data196.occurrence_state !== undefined) {
                  let data202 = data196.occurrence_state;
                  if (!(
                    data202 === "new" ||
                    data202 === "pre-existing" ||
                    data202 === "fixed" ||
                    data202 === "unclassified"
                  )) {
                    const err484 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/location/occurrence_state",
                      schemaPath:
                        "#/$defs/finding/properties/location/properties/occurrence_state/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.location.properties
                            .occurrence_state.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err484];
                    } else {
                      vErrors.push(err484);
                    }
                    errors++;
                  }
                }
              } else {
                const err485 = {
                  instancePath: instancePath + "/security/" + i22 + "/location",
                  schemaPath: "#/$defs/finding/properties/location/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err485];
                } else {
                  vErrors.push(err485);
                }
                errors++;
              }
            }
            if (data188.message !== undefined) {
              let data203 = data188.message;
              if (typeof data203 === "string") {
                if (func2(data203) < 1) {
                  const err486 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/message",
                    schemaPath: "#/$defs/finding/properties/message/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err486];
                  } else {
                    vErrors.push(err486);
                  }
                  errors++;
                }
              } else {
                const err487 = {
                  instancePath: instancePath + "/security/" + i22 + "/message",
                  schemaPath: "#/$defs/finding/properties/message/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err487];
                } else {
                  vErrors.push(err487);
                }
                errors++;
              }
            }
            if (data188.trigger !== undefined) {
              if (typeof data188.trigger !== "string") {
                const err488 = {
                  instancePath: instancePath + "/security/" + i22 + "/trigger",
                  schemaPath: "#/$defs/finding/properties/trigger/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err488];
                } else {
                  vErrors.push(err488);
                }
                errors++;
              }
            }
            if (data188.impact !== undefined) {
              let data205 = data188.impact;
              if (typeof data205 === "string") {
                if (func2(data205) < 1) {
                  const err489 = {
                    instancePath: instancePath + "/security/" + i22 + "/impact",
                    schemaPath: "#/$defs/finding/properties/impact/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err489];
                  } else {
                    vErrors.push(err489);
                  }
                  errors++;
                }
              } else {
                const err490 = {
                  instancePath: instancePath + "/security/" + i22 + "/impact",
                  schemaPath: "#/$defs/finding/properties/impact/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err490];
                } else {
                  vErrors.push(err490);
                }
                errors++;
              }
            }
            if (data188.suggested_fix !== undefined) {
              let data206 = data188.suggested_fix;
              if (typeof data206 === "string") {
                if (func2(data206) < 1) {
                  const err491 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/suggested_fix",
                    schemaPath:
                      "#/$defs/finding/properties/suggested_fix/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err491];
                  } else {
                    vErrors.push(err491);
                  }
                  errors++;
                }
              } else {
                const err492 = {
                  instancePath:
                    instancePath + "/security/" + i22 + "/suggested_fix",
                  schemaPath: "#/$defs/finding/properties/suggested_fix/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err492];
                } else {
                  vErrors.push(err492);
                }
                errors++;
              }
            }
            if (data188.evidence !== undefined) {
              let data207 = data188.evidence;
              if (Array.isArray(data207)) {
                const len23 = data207.length;
                for (let i23 = 0; i23 < len23; i23++) {
                  let data208 = data207[i23];
                  if (typeof data208 === "string") {
                    if (func2(data208) < 1) {
                      const err493 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/evidence/" +
                          i23,
                        schemaPath:
                          "#/$defs/finding/properties/evidence/items/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err493];
                      } else {
                        vErrors.push(err493);
                      }
                      errors++;
                    }
                  } else {
                    const err494 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/evidence/" + i23,
                      schemaPath:
                        "#/$defs/finding/properties/evidence/items/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err494];
                    } else {
                      vErrors.push(err494);
                    }
                    errors++;
                  }
                }
              } else {
                const err495 = {
                  instancePath: instancePath + "/security/" + i22 + "/evidence",
                  schemaPath: "#/$defs/finding/properties/evidence/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err495];
                } else {
                  vErrors.push(err495);
                }
                errors++;
              }
            }
            if (data188.source !== undefined) {
              let data209 = data188.source;
              const _errs450 = errors;
              let valid102 = false;
              let passing3 = null;
              const _errs451 = errors;
              if (
                data209 &&
                typeof data209 == "object" &&
                !Array.isArray(data209)
              ) {
                if (data209.tool === undefined) {
                  const err496 = {
                    instancePath: instancePath + "/security/" + i22 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/0/required",
                    keyword: "required",
                    params: { missingProperty: "tool" },
                    message: "must have required property '" + "tool" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err496];
                  } else {
                    vErrors.push(err496);
                  }
                  errors++;
                }
                if (data209.version === undefined) {
                  const err497 = {
                    instancePath: instancePath + "/security/" + i22 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/0/required",
                    keyword: "required",
                    params: { missingProperty: "version" },
                    message: "must have required property '" + "version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err497];
                  } else {
                    vErrors.push(err497);
                  }
                  errors++;
                }
                for (const key35 in data209) {
                  if (!(key35 === "tool" || key35 === "version")) {
                    const err498 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/source",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key35 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err498];
                    } else {
                      vErrors.push(err498);
                    }
                    errors++;
                  }
                }
                if (data209.tool !== undefined) {
                  let data210 = data209.tool;
                  if (typeof data210 === "string") {
                    if (func2(data210) < 1) {
                      const err499 = {
                        instancePath:
                          instancePath + "/security/" + i22 + "/source/tool",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/0/properties/tool/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err499];
                      } else {
                        vErrors.push(err499);
                      }
                      errors++;
                    }
                  } else {
                    const err500 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/source/tool",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/properties/tool/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err500];
                    } else {
                      vErrors.push(err500);
                    }
                    errors++;
                  }
                }
                if (data209.version !== undefined) {
                  let data211 = data209.version;
                  if (typeof data211 === "string") {
                    if (func2(data211) < 1) {
                      const err501 = {
                        instancePath:
                          instancePath + "/security/" + i22 + "/source/version",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/0/properties/version/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err501];
                      } else {
                        vErrors.push(err501);
                      }
                      errors++;
                    }
                  } else {
                    const err502 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/source/version",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/0/properties/version/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err502];
                    } else {
                      vErrors.push(err502);
                    }
                    errors++;
                  }
                }
              } else {
                const err503 = {
                  instancePath: instancePath + "/security/" + i22 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf/0/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err503];
                } else {
                  vErrors.push(err503);
                }
                errors++;
              }
              var _valid7 = _errs451 === errors;
              if (_valid7) {
                valid102 = true;
                passing3 = 0;
                var props3 = true;
              }
              const _errs458 = errors;
              if (
                data209 &&
                typeof data209 == "object" &&
                !Array.isArray(data209)
              ) {
                if (data209.agent === undefined) {
                  const err504 = {
                    instancePath: instancePath + "/security/" + i22 + "/source",
                    schemaPath:
                      "#/$defs/finding/properties/source/oneOf/1/required",
                    keyword: "required",
                    params: { missingProperty: "agent" },
                    message: "must have required property '" + "agent" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err504];
                  } else {
                    vErrors.push(err504);
                  }
                  errors++;
                }
                for (const key36 in data209) {
                  if (!(key36 === "agent")) {
                    const err505 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/source",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/1/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key36 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err505];
                    } else {
                      vErrors.push(err505);
                    }
                    errors++;
                  }
                }
                if (data209.agent !== undefined) {
                  let data212 = data209.agent;
                  if (typeof data212 === "string") {
                    if (func2(data212) < 1) {
                      const err506 = {
                        instancePath:
                          instancePath + "/security/" + i22 + "/source/agent",
                        schemaPath:
                          "#/$defs/finding/properties/source/oneOf/1/properties/agent/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err506];
                      } else {
                        vErrors.push(err506);
                      }
                      errors++;
                    }
                  } else {
                    const err507 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/source/agent",
                      schemaPath:
                        "#/$defs/finding/properties/source/oneOf/1/properties/agent/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err507];
                    } else {
                      vErrors.push(err507);
                    }
                    errors++;
                  }
                }
              } else {
                const err508 = {
                  instancePath: instancePath + "/security/" + i22 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf/1/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err508];
                } else {
                  vErrors.push(err508);
                }
                errors++;
              }
              var _valid7 = _errs458 === errors;
              if (_valid7 && valid102) {
                valid102 = false;
                passing3 = [passing3, 1];
              } else {
                if (_valid7) {
                  valid102 = true;
                  passing3 = 1;
                  if (props3 !== true) {
                    props3 = true;
                  }
                }
              }
              if (!valid102) {
                const err509 = {
                  instancePath: instancePath + "/security/" + i22 + "/source",
                  schemaPath: "#/$defs/finding/properties/source/oneOf",
                  keyword: "oneOf",
                  params: { passingSchemas: passing3 },
                  message: "must match exactly one schema in oneOf",
                };
                if (vErrors === null) {
                  vErrors = [err509];
                } else {
                  vErrors.push(err509);
                }
                errors++;
              } else {
                errors = _errs450;
                if (vErrors !== null) {
                  if (_errs450) {
                    vErrors.length = _errs450;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
            if (data188.locations !== undefined) {
              let data213 = data188.locations;
              if (Array.isArray(data213)) {
                if (data213.length < 1) {
                  const err510 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/locations",
                    schemaPath: "#/$defs/finding/properties/locations/minItems",
                    keyword: "minItems",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 items",
                  };
                  if (vErrors === null) {
                    vErrors = [err510];
                  } else {
                    vErrors.push(err510);
                  }
                  errors++;
                }
                const len24 = data213.length;
                for (let i24 = 0; i24 < len24; i24++) {
                  let data214 = data213[i24];
                  if (
                    data214 &&
                    typeof data214 == "object" &&
                    !Array.isArray(data214)
                  ) {
                    if (data214.path === undefined) {
                      const err511 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/locations/" +
                          i24,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "path" },
                        message: "must have required property '" + "path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err511];
                      } else {
                        vErrors.push(err511);
                      }
                      errors++;
                    }
                    if (data214.line_start === undefined) {
                      const err512 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/locations/" +
                          i24,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_start" },
                        message:
                          "must have required property '" + "line_start" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err512];
                      } else {
                        vErrors.push(err512);
                      }
                      errors++;
                    }
                    if (data214.line_end === undefined) {
                      const err513 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/locations/" +
                          i24,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_end" },
                        message:
                          "must have required property '" + "line_end" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err513];
                      } else {
                        vErrors.push(err513);
                      }
                      errors++;
                    }
                    if (data214.symbol_path === undefined) {
                      const err514 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/locations/" +
                          i24,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "symbol_path" },
                        message:
                          "must have required property '" + "symbol_path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err514];
                      } else {
                        vErrors.push(err514);
                      }
                      errors++;
                    }
                    if (data214.occurrence_state === undefined) {
                      const err515 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/locations/" +
                          i24,
                        schemaPath:
                          "#/$defs/finding/properties/locations/items/required",
                        keyword: "required",
                        params: { missingProperty: "occurrence_state" },
                        message:
                          "must have required property '" +
                          "occurrence_state" +
                          "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err515];
                      } else {
                        vErrors.push(err515);
                      }
                      errors++;
                    }
                    for (const key37 in data214) {
                      if (!(
                        key37 === "path" ||
                        key37 === "line_start" ||
                        key37 === "line_end" ||
                        key37 === "column" ||
                        key37 === "symbol_path" ||
                        key37 === "occurrence_state" ||
                        key37 === "id"
                      )) {
                        const err516 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/locations/" +
                            i24,
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/additionalProperties",
                          keyword: "additionalProperties",
                          params: { additionalProperty: key37 },
                          message: "must NOT have additional properties",
                        };
                        if (vErrors === null) {
                          vErrors = [err516];
                        } else {
                          vErrors.push(err516);
                        }
                        errors++;
                      }
                    }
                    if (data214.path !== undefined) {
                      let data215 = data214.path;
                      if (typeof data215 === "string") {
                        if (func2(data215) < 1) {
                          const err517 = {
                            instancePath:
                              instancePath +
                              "/security/" +
                              i22 +
                              "/locations/" +
                              i24 +
                              "/path",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/path/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err517];
                          } else {
                            vErrors.push(err517);
                          }
                          errors++;
                        }
                        if (!pattern8.test(data215)) {
                          const err518 = {
                            instancePath:
                              instancePath +
                              "/security/" +
                              i22 +
                              "/locations/" +
                              i24 +
                              "/path",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/path/pattern",
                            keyword: "pattern",
                            params: {
                              pattern:
                                "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                            },
                            message:
                              'must match pattern "' +
                              "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                              '"',
                          };
                          if (vErrors === null) {
                            vErrors = [err518];
                          } else {
                            vErrors.push(err518);
                          }
                          errors++;
                        }
                      } else {
                        const err519 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/locations/" +
                            i24 +
                            "/path",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err519];
                        } else {
                          vErrors.push(err519);
                        }
                        errors++;
                      }
                    }
                    if (data214.line_start !== undefined) {
                      let data216 = data214.line_start;
                      if (!(
                        typeof data216 == "number" &&
                        !(data216 % 1) &&
                        !isNaN(data216)
                      )) {
                        const err520 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/locations/" +
                            i24 +
                            "/line_start",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/line_start/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err520];
                        } else {
                          vErrors.push(err520);
                        }
                        errors++;
                      }
                      if (typeof data216 == "number") {
                        if (data216 < 1 || isNaN(data216)) {
                          const err521 = {
                            instancePath:
                              instancePath +
                              "/security/" +
                              i22 +
                              "/locations/" +
                              i24 +
                              "/line_start",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/line_start/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err521];
                          } else {
                            vErrors.push(err521);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data214.line_end !== undefined) {
                      let data217 = data214.line_end;
                      if (!(
                        typeof data217 == "number" &&
                        !(data217 % 1) &&
                        !isNaN(data217)
                      )) {
                        const err522 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/locations/" +
                            i24 +
                            "/line_end",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/line_end/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err522];
                        } else {
                          vErrors.push(err522);
                        }
                        errors++;
                      }
                      if (typeof data217 == "number") {
                        if (data217 < 1 || isNaN(data217)) {
                          const err523 = {
                            instancePath:
                              instancePath +
                              "/security/" +
                              i22 +
                              "/locations/" +
                              i24 +
                              "/line_end",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/line_end/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err523];
                          } else {
                            vErrors.push(err523);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data214.column !== undefined) {
                      let data218 = data214.column;
                      if (!(
                        typeof data218 == "number" &&
                        !(data218 % 1) &&
                        !isNaN(data218)
                      )) {
                        const err524 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/locations/" +
                            i24 +
                            "/column",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/column/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err524];
                        } else {
                          vErrors.push(err524);
                        }
                        errors++;
                      }
                      if (typeof data218 == "number") {
                        if (data218 < 1 || isNaN(data218)) {
                          const err525 = {
                            instancePath:
                              instancePath +
                              "/security/" +
                              i22 +
                              "/locations/" +
                              i24 +
                              "/column",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/column/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err525];
                          } else {
                            vErrors.push(err525);
                          }
                          errors++;
                        }
                      }
                    }
                    if (data214.symbol_path !== undefined) {
                      if (typeof data214.symbol_path !== "string") {
                        const err526 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/locations/" +
                            i24 +
                            "/symbol_path",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/symbol_path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err526];
                        } else {
                          vErrors.push(err526);
                        }
                        errors++;
                      }
                    }
                    if (data214.occurrence_state !== undefined) {
                      let data220 = data214.occurrence_state;
                      if (!(
                        data220 === "new" ||
                        data220 === "pre-existing" ||
                        data220 === "fixed" ||
                        data220 === "unclassified"
                      )) {
                        const err527 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/locations/" +
                            i24 +
                            "/occurrence_state",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/occurrence_state/enum",
                          keyword: "enum",
                          params: {
                            allowedValues:
                              schema34.properties.locations.items.properties
                                .occurrence_state.enum,
                          },
                          message: "must be equal to one of the allowed values",
                        };
                        if (vErrors === null) {
                          vErrors = [err527];
                        } else {
                          vErrors.push(err527);
                        }
                        errors++;
                      }
                    }
                    if (data214.id !== undefined) {
                      let data221 = data214.id;
                      if (typeof data221 === "string") {
                        if (func2(data221) < 1) {
                          const err528 = {
                            instancePath:
                              instancePath +
                              "/security/" +
                              i22 +
                              "/locations/" +
                              i24 +
                              "/id",
                            schemaPath:
                              "#/$defs/finding/properties/locations/items/properties/id/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err528];
                          } else {
                            vErrors.push(err528);
                          }
                          errors++;
                        }
                      } else {
                        const err529 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/locations/" +
                            i24 +
                            "/id",
                          schemaPath:
                            "#/$defs/finding/properties/locations/items/properties/id/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err529];
                        } else {
                          vErrors.push(err529);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err530 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/locations/" + i24,
                      schemaPath:
                        "#/$defs/finding/properties/locations/items/type",
                      keyword: "type",
                      params: { type: "object" },
                      message: "must be object",
                    };
                    if (vErrors === null) {
                      vErrors = [err530];
                    } else {
                      vErrors.push(err530);
                    }
                    errors++;
                  }
                }
              } else {
                const err531 = {
                  instancePath:
                    instancePath + "/security/" + i22 + "/locations",
                  schemaPath: "#/$defs/finding/properties/locations/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err531];
                } else {
                  vErrors.push(err531);
                }
                errors++;
              }
            }
            if (data188.advisory !== undefined) {
              let data222 = data188.advisory;
              if (
                data222 &&
                typeof data222 == "object" &&
                !Array.isArray(data222)
              ) {
                if (data222.id === undefined) {
                  const err532 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "id" },
                    message: "must have required property '" + "id" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err532];
                  } else {
                    vErrors.push(err532);
                  }
                  errors++;
                }
                if (data222.aliases === undefined) {
                  const err533 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "aliases" },
                    message: "must have required property '" + "aliases" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err533];
                  } else {
                    vErrors.push(err533);
                  }
                  errors++;
                }
                if (data222.severity === undefined) {
                  const err534 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "severity" },
                    message: "must have required property '" + "severity" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err534];
                  } else {
                    vErrors.push(err534);
                  }
                  errors++;
                }
                if (data222.fixed_version === undefined) {
                  const err535 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "fixed_version" },
                    message:
                      "must have required property '" + "fixed_version" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err535];
                  } else {
                    vErrors.push(err535);
                  }
                  errors++;
                }
                if (data222.url === undefined) {
                  const err536 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/advisory",
                    schemaPath: "#/$defs/finding/properties/advisory/required",
                    keyword: "required",
                    params: { missingProperty: "url" },
                    message: "must have required property '" + "url" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err536];
                  } else {
                    vErrors.push(err536);
                  }
                  errors++;
                }
                for (const key38 in data222) {
                  if (!(
                    key38 === "id" ||
                    key38 === "aliases" ||
                    key38 === "severity" ||
                    key38 === "fixed_version" ||
                    key38 === "url"
                  )) {
                    const err537 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/advisory",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key38 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err537];
                    } else {
                      vErrors.push(err537);
                    }
                    errors++;
                  }
                }
                if (data222.id !== undefined) {
                  let data223 = data222.id;
                  if (typeof data223 === "string") {
                    if (func2(data223) < 1) {
                      const err538 = {
                        instancePath:
                          instancePath + "/security/" + i22 + "/advisory/id",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/id/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err538];
                      } else {
                        vErrors.push(err538);
                      }
                      errors++;
                    }
                  } else {
                    const err539 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/advisory/id",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/id/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err539];
                    } else {
                      vErrors.push(err539);
                    }
                    errors++;
                  }
                }
                if (data222.aliases !== undefined) {
                  let data224 = data222.aliases;
                  if (Array.isArray(data224)) {
                    const len25 = data224.length;
                    for (let i25 = 0; i25 < len25; i25++) {
                      let data225 = data224[i25];
                      if (typeof data225 === "string") {
                        if (func2(data225) < 1) {
                          const err540 = {
                            instancePath:
                              instancePath +
                              "/security/" +
                              i22 +
                              "/advisory/aliases/" +
                              i25,
                            schemaPath:
                              "#/$defs/finding/properties/advisory/properties/aliases/items/minLength",
                            keyword: "minLength",
                            params: { limit: 1 },
                            message: "must NOT have fewer than 1 characters",
                          };
                          if (vErrors === null) {
                            vErrors = [err540];
                          } else {
                            vErrors.push(err540);
                          }
                          errors++;
                        }
                      } else {
                        const err541 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/advisory/aliases/" +
                            i25,
                          schemaPath:
                            "#/$defs/finding/properties/advisory/properties/aliases/items/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err541];
                        } else {
                          vErrors.push(err541);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err542 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/advisory/aliases",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/aliases/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err542];
                    } else {
                      vErrors.push(err542);
                    }
                    errors++;
                  }
                }
                if (data222.severity !== undefined) {
                  let data226 = data222.severity;
                  if (!(
                    data226 === "critical" ||
                    data226 === "high" ||
                    data226 === "moderate" ||
                    data226 === "low" ||
                    data226 === "unknown"
                  )) {
                    const err543 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/advisory/severity",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/severity/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.advisory.properties.severity.enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err543];
                    } else {
                      vErrors.push(err543);
                    }
                    errors++;
                  }
                }
                if (data222.fixed_version !== undefined) {
                  let data227 = data222.fixed_version;
                  if (typeof data227 === "string") {
                    if (func2(data227) < 1) {
                      const err544 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/advisory/fixed_version",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/fixed_version/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err544];
                      } else {
                        vErrors.push(err544);
                      }
                      errors++;
                    }
                  } else {
                    const err545 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/advisory/fixed_version",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/fixed_version/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err545];
                    } else {
                      vErrors.push(err545);
                    }
                    errors++;
                  }
                }
                if (data222.url !== undefined) {
                  let data228 = data222.url;
                  if (typeof data228 === "string") {
                    if (!pattern10.test(data228)) {
                      const err546 = {
                        instancePath:
                          instancePath + "/security/" + i22 + "/advisory/url",
                        schemaPath:
                          "#/$defs/finding/properties/advisory/properties/url/pattern",
                        keyword: "pattern",
                        params: { pattern: "^https://" },
                        message: 'must match pattern "' + "^https://" + '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err546];
                      } else {
                        vErrors.push(err546);
                      }
                      errors++;
                    }
                  } else {
                    const err547 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/advisory/url",
                      schemaPath:
                        "#/$defs/finding/properties/advisory/properties/url/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err547];
                    } else {
                      vErrors.push(err547);
                    }
                    errors++;
                  }
                }
              } else {
                const err548 = {
                  instancePath: instancePath + "/security/" + i22 + "/advisory",
                  schemaPath: "#/$defs/finding/properties/advisory/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err548];
                } else {
                  vErrors.push(err548);
                }
                errors++;
              }
            }
            if (data188.round !== undefined) {
              let data229 = data188.round;
              if (!(
                typeof data229 == "number" &&
                !(data229 % 1) &&
                !isNaN(data229)
              )) {
                const err549 = {
                  instancePath: instancePath + "/security/" + i22 + "/round",
                  schemaPath: "#/$defs/finding/properties/round/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err549];
                } else {
                  vErrors.push(err549);
                }
                errors++;
              }
              if (typeof data229 == "number") {
                if (data229 < 1 || isNaN(data229)) {
                  const err550 = {
                    instancePath: instancePath + "/security/" + i22 + "/round",
                    schemaPath: "#/$defs/finding/properties/round/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err550];
                  } else {
                    vErrors.push(err550);
                  }
                  errors++;
                }
              }
            }
            if (data188.first_posted_in !== undefined) {
              let data230 = data188.first_posted_in;
              if (typeof data230 === "string") {
                if (func2(data230) < 1) {
                  const err551 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/first_posted_in",
                    schemaPath:
                      "#/$defs/finding/properties/first_posted_in/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err551];
                  } else {
                    vErrors.push(err551);
                  }
                  errors++;
                }
              } else {
                const err552 = {
                  instancePath:
                    instancePath + "/security/" + i22 + "/first_posted_in",
                  schemaPath: "#/$defs/finding/properties/first_posted_in/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err552];
                } else {
                  vErrors.push(err552);
                }
                errors++;
              }
            }
            if (data188.author_response !== undefined) {
              let data231 = data188.author_response;
              if (
                data231 &&
                typeof data231 == "object" &&
                !Array.isArray(data231)
              ) {
                if (data231.reason === undefined) {
                  const err553 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "reason" },
                    message: "must have required property '" + "reason" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err553];
                  } else {
                    vErrors.push(err553);
                  }
                  errors++;
                }
                if (data231.actor === undefined) {
                  const err554 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "actor" },
                    message: "must have required property '" + "actor" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err554];
                  } else {
                    vErrors.push(err554);
                  }
                  errors++;
                }
                if (data231.at === undefined) {
                  const err555 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/author_response",
                    schemaPath:
                      "#/$defs/finding/properties/author_response/required",
                    keyword: "required",
                    params: { missingProperty: "at" },
                    message: "must have required property '" + "at" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err555];
                  } else {
                    vErrors.push(err555);
                  }
                  errors++;
                }
                for (const key39 in data231) {
                  if (!(
                    key39 === "reason" ||
                    key39 === "actor" ||
                    key39 === "at" ||
                    key39 === "note"
                  )) {
                    const err556 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/author_response",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key39 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err556];
                    } else {
                      vErrors.push(err556);
                    }
                    errors++;
                  }
                }
                if (data231.reason !== undefined) {
                  let data232 = data231.reason;
                  if (!(
                    data232 === "fixed" ||
                    data232 === "wrong" ||
                    data232 === "intentional" ||
                    data232 === "irrelevant" ||
                    data232 === "style"
                  )) {
                    const err557 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/author_response/reason",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/reason/enum",
                      keyword: "enum",
                      params: {
                        allowedValues:
                          schema34.properties.author_response.properties.reason
                            .enum,
                      },
                      message: "must be equal to one of the allowed values",
                    };
                    if (vErrors === null) {
                      vErrors = [err557];
                    } else {
                      vErrors.push(err557);
                    }
                    errors++;
                  }
                }
                if (data231.actor !== undefined) {
                  let data233 = data231.actor;
                  if (typeof data233 === "string") {
                    if (func2(data233) < 1) {
                      const err558 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/author_response/actor",
                        schemaPath:
                          "#/$defs/finding/properties/author_response/properties/actor/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err558];
                      } else {
                        vErrors.push(err558);
                      }
                      errors++;
                    }
                  } else {
                    const err559 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/author_response/actor",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/actor/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err559];
                    } else {
                      vErrors.push(err559);
                    }
                    errors++;
                  }
                }
                if (data231.at !== undefined) {
                  let data234 = data231.at;
                  if (typeof data234 === "string") {
                    if (!formats0.validate(data234)) {
                      const err560 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/author_response/at",
                        schemaPath:
                          "#/$defs/finding/properties/author_response/properties/at/format",
                        keyword: "format",
                        params: { format: "date-time" },
                        message: 'must match format "' + "date-time" + '"',
                      };
                      if (vErrors === null) {
                        vErrors = [err560];
                      } else {
                        vErrors.push(err560);
                      }
                      errors++;
                    }
                  } else {
                    const err561 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/author_response/at",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/at/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err561];
                    } else {
                      vErrors.push(err561);
                    }
                    errors++;
                  }
                }
                if (data231.note !== undefined) {
                  if (typeof data231.note !== "string") {
                    const err562 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/author_response/note",
                      schemaPath:
                        "#/$defs/finding/properties/author_response/properties/note/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err562];
                    } else {
                      vErrors.push(err562);
                    }
                    errors++;
                  }
                }
              } else {
                const err563 = {
                  instancePath:
                    instancePath + "/security/" + i22 + "/author_response",
                  schemaPath: "#/$defs/finding/properties/author_response/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err563];
                } else {
                  vErrors.push(err563);
                }
                errors++;
              }
            }
            if (data188.status !== undefined) {
              let data236 = data188.status;
              if (!(
                data236 === "open" ||
                data236 === "fixed" ||
                data236 === "dismissed"
              )) {
                const err564 = {
                  instancePath: instancePath + "/security/" + i22 + "/status",
                  schemaPath: "#/$defs/finding/properties/status/enum",
                  keyword: "enum",
                  params: { allowedValues: schema34.properties.status.enum },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err564];
                } else {
                  vErrors.push(err564);
                }
                errors++;
              }
            }
            if (data188.resolution !== undefined) {
              let data237 = data188.resolution;
              if (
                data237 &&
                typeof data237 == "object" &&
                !Array.isArray(data237)
              ) {
                for (const key40 in data237) {
                  if (!(key40 === "fixed_in" || key40 === "note")) {
                    const err565 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/resolution",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key40 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err565];
                    } else {
                      vErrors.push(err565);
                    }
                    errors++;
                  }
                }
                if (data237.fixed_in !== undefined) {
                  let data238 = data237.fixed_in;
                  if (typeof data238 === "string") {
                    if (func2(data238) < 1) {
                      const err566 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/resolution/fixed_in",
                        schemaPath:
                          "#/$defs/finding/properties/resolution/properties/fixed_in/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err566];
                      } else {
                        vErrors.push(err566);
                      }
                      errors++;
                    }
                  } else {
                    const err567 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/resolution/fixed_in",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/properties/fixed_in/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err567];
                    } else {
                      vErrors.push(err567);
                    }
                    errors++;
                  }
                }
                if (data237.note !== undefined) {
                  let data239 = data237.note;
                  if (typeof data239 === "string") {
                    if (func2(data239) < 1) {
                      const err568 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/resolution/note",
                        schemaPath:
                          "#/$defs/finding/properties/resolution/properties/note/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err568];
                      } else {
                        vErrors.push(err568);
                      }
                      errors++;
                    }
                  } else {
                    const err569 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/resolution/note",
                      schemaPath:
                        "#/$defs/finding/properties/resolution/properties/note/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err569];
                    } else {
                      vErrors.push(err569);
                    }
                    errors++;
                  }
                }
              } else {
                const err570 = {
                  instancePath:
                    instancePath + "/security/" + i22 + "/resolution",
                  schemaPath: "#/$defs/finding/properties/resolution/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err570];
                } else {
                  vErrors.push(err570);
                }
                errors++;
              }
            }
            if (data188.verification !== undefined) {
              let data240 = data188.verification;
              if (
                data240 &&
                typeof data240 == "object" &&
                !Array.isArray(data240)
              ) {
                if (data240.voters === undefined) {
                  const err571 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "voters" },
                    message: "must have required property '" + "voters" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err571];
                  } else {
                    vErrors.push(err571);
                  }
                  errors++;
                }
                if (data240.agreeing === undefined) {
                  const err572 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "agreeing" },
                    message: "must have required property '" + "agreeing" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err572];
                  } else {
                    vErrors.push(err572);
                  }
                  errors++;
                }
                if (data240.blind_match === undefined) {
                  const err573 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "blind_match" },
                    message:
                      "must have required property '" + "blind_match" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err573];
                  } else {
                    vErrors.push(err573);
                  }
                  errors++;
                }
                if (data240.split === undefined) {
                  const err574 = {
                    instancePath:
                      instancePath + "/security/" + i22 + "/verification",
                    schemaPath:
                      "#/$defs/finding/properties/verification/required",
                    keyword: "required",
                    params: { missingProperty: "split" },
                    message: "must have required property '" + "split" + "'",
                  };
                  if (vErrors === null) {
                    vErrors = [err574];
                  } else {
                    vErrors.push(err574);
                  }
                  errors++;
                }
                for (const key41 in data240) {
                  if (!(
                    key41 === "voters" ||
                    key41 === "agreeing" ||
                    key41 === "blind_match" ||
                    key41 === "split"
                  )) {
                    const err575 = {
                      instancePath:
                        instancePath + "/security/" + i22 + "/verification",
                      schemaPath:
                        "#/$defs/finding/properties/verification/additionalProperties",
                      keyword: "additionalProperties",
                      params: { additionalProperty: key41 },
                      message: "must NOT have additional properties",
                    };
                    if (vErrors === null) {
                      vErrors = [err575];
                    } else {
                      vErrors.push(err575);
                    }
                    errors++;
                  }
                }
                if (data240.voters !== undefined) {
                  let data241 = data240.voters;
                  if (!(
                    typeof data241 == "number" &&
                    !(data241 % 1) &&
                    !isNaN(data241)
                  )) {
                    const err576 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/verification/voters",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/voters/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err576];
                    } else {
                      vErrors.push(err576);
                    }
                    errors++;
                  }
                  if (typeof data241 == "number") {
                    if (data241 < 1 || isNaN(data241)) {
                      const err577 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/verification/voters",
                        schemaPath:
                          "#/$defs/finding/properties/verification/properties/voters/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 1 },
                        message: "must be >= 1",
                      };
                      if (vErrors === null) {
                        vErrors = [err577];
                      } else {
                        vErrors.push(err577);
                      }
                      errors++;
                    }
                  }
                }
                if (data240.agreeing !== undefined) {
                  let data242 = data240.agreeing;
                  if (!(
                    typeof data242 == "number" &&
                    !(data242 % 1) &&
                    !isNaN(data242)
                  )) {
                    const err578 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/verification/agreeing",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/agreeing/type",
                      keyword: "type",
                      params: { type: "integer" },
                      message: "must be integer",
                    };
                    if (vErrors === null) {
                      vErrors = [err578];
                    } else {
                      vErrors.push(err578);
                    }
                    errors++;
                  }
                  if (typeof data242 == "number") {
                    if (data242 < 0 || isNaN(data242)) {
                      const err579 = {
                        instancePath:
                          instancePath +
                          "/security/" +
                          i22 +
                          "/verification/agreeing",
                        schemaPath:
                          "#/$defs/finding/properties/verification/properties/agreeing/minimum",
                        keyword: "minimum",
                        params: { comparison: ">=", limit: 0 },
                        message: "must be >= 0",
                      };
                      if (vErrors === null) {
                        vErrors = [err579];
                      } else {
                        vErrors.push(err579);
                      }
                      errors++;
                    }
                  }
                }
                if (data240.blind_match !== undefined) {
                  let data243 = data240.blind_match;
                  if (Array.isArray(data243)) {
                    const len26 = data243.length;
                    for (let i26 = 0; i26 < len26; i26++) {
                      let data244 = data243[i26];
                      if (!(
                        data244 === "same" ||
                        data244 === "related" ||
                        data244 === "none"
                      )) {
                        const err580 = {
                          instancePath:
                            instancePath +
                            "/security/" +
                            i22 +
                            "/verification/blind_match/" +
                            i26,
                          schemaPath:
                            "#/$defs/finding/properties/verification/properties/blind_match/items/enum",
                          keyword: "enum",
                          params: {
                            allowedValues:
                              schema34.properties.verification.properties
                                .blind_match.items.enum,
                          },
                          message: "must be equal to one of the allowed values",
                        };
                        if (vErrors === null) {
                          vErrors = [err580];
                        } else {
                          vErrors.push(err580);
                        }
                        errors++;
                      }
                    }
                  } else {
                    const err581 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/verification/blind_match",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/blind_match/type",
                      keyword: "type",
                      params: { type: "array" },
                      message: "must be array",
                    };
                    if (vErrors === null) {
                      vErrors = [err581];
                    } else {
                      vErrors.push(err581);
                    }
                    errors++;
                  }
                }
                if (data240.split !== undefined) {
                  if (typeof data240.split !== "boolean") {
                    const err582 = {
                      instancePath:
                        instancePath +
                        "/security/" +
                        i22 +
                        "/verification/split",
                      schemaPath:
                        "#/$defs/finding/properties/verification/properties/split/type",
                      keyword: "type",
                      params: { type: "boolean" },
                      message: "must be boolean",
                    };
                    if (vErrors === null) {
                      vErrors = [err582];
                    } else {
                      vErrors.push(err582);
                    }
                    errors++;
                  }
                }
              } else {
                const err583 = {
                  instancePath:
                    instancePath + "/security/" + i22 + "/verification",
                  schemaPath: "#/$defs/finding/properties/verification/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err583];
                } else {
                  vErrors.push(err583);
                }
                errors++;
              }
            }
          } else {
            const err584 = {
              instancePath: instancePath + "/security/" + i22,
              schemaPath: "#/$defs/finding/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err584];
            } else {
              vErrors.push(err584);
            }
            errors++;
          }
        }
      } else {
        const err585 = {
          instancePath: instancePath + "/security",
          schemaPath: "#/properties/security/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err585];
        } else {
          vErrors.push(err585);
        }
        errors++;
      }
    }
    if (data.agent_audit !== undefined) {
      let data246 = data.agent_audit;
      if (data246 && typeof data246 == "object" && !Array.isArray(data246)) {
      } else {
        const err586 = {
          instancePath: instancePath + "/agent_audit",
          schemaPath: "#/properties/agent_audit/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err586];
        } else {
          vErrors.push(err586);
        }
        errors++;
      }
    }
    if (data.lineage !== undefined) {
      let data247 = data.lineage;
      if (data247 && typeof data247 == "object" && !Array.isArray(data247)) {
        if (data247.repository === undefined) {
          const err587 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "repository" },
            message: "must have required property '" + "repository" + "'",
          };
          if (vErrors === null) {
            vErrors = [err587];
          } else {
            vErrors.push(err587);
          }
          errors++;
        }
        if (data247.kind === undefined) {
          const err588 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "kind" },
            message: "must have required property '" + "kind" + "'",
          };
          if (vErrors === null) {
            vErrors = [err588];
          } else {
            vErrors.push(err588);
          }
          errors++;
        }
        if (data247.ref === undefined) {
          const err589 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "ref" },
            message: "must have required property '" + "ref" + "'",
          };
          if (vErrors === null) {
            vErrors = [err589];
          } else {
            vErrors.push(err589);
          }
          errors++;
        }
        if (data247.generation === undefined) {
          const err590 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "generation" },
            message: "must have required property '" + "generation" + "'",
          };
          if (vErrors === null) {
            vErrors = [err590];
          } else {
            vErrors.push(err590);
          }
          errors++;
        }
        if (data247.round === undefined) {
          const err591 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "round" },
            message: "must have required property '" + "round" + "'",
          };
          if (vErrors === null) {
            vErrors = [err591];
          } else {
            vErrors.push(err591);
          }
          errors++;
        }
        if (data247.cap === undefined) {
          const err592 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "cap" },
            message: "must have required property '" + "cap" + "'",
          };
          if (vErrors === null) {
            vErrors = [err592];
          } else {
            vErrors.push(err592);
          }
          errors++;
        }
        if (data247.capped === undefined) {
          const err593 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "capped" },
            message: "must have required property '" + "capped" + "'",
          };
          if (vErrors === null) {
            vErrors = [err593];
          } else {
            vErrors.push(err593);
          }
          errors++;
        }
        if (data247.diff_only === undefined) {
          const err594 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "diff_only" },
            message: "must have required property '" + "diff_only" + "'",
          };
          if (vErrors === null) {
            vErrors = [err594];
          } else {
            vErrors.push(err594);
          }
          errors++;
        }
        if (data247.previous_head === undefined) {
          const err595 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "previous_head" },
            message: "must have required property '" + "previous_head" + "'",
          };
          if (vErrors === null) {
            vErrors = [err595];
          } else {
            vErrors.push(err595);
          }
          errors++;
        }
        if (data247.held_back === undefined) {
          const err596 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "held_back" },
            message: "must have required property '" + "held_back" + "'",
          };
          if (vErrors === null) {
            vErrors = [err596];
          } else {
            vErrors.push(err596);
          }
          errors++;
        }
        if (data247.rounds_to_pass === undefined) {
          const err597 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "rounds_to_pass" },
            message: "must have required property '" + "rounds_to_pass" + "'",
          };
          if (vErrors === null) {
            vErrors = [err597];
          } else {
            vErrors.push(err597);
          }
          errors++;
        }
        if (data247.author_response_ratio === undefined) {
          const err598 = {
            instancePath: instancePath + "/lineage",
            schemaPath: "#/properties/lineage/required",
            keyword: "required",
            params: { missingProperty: "author_response_ratio" },
            message:
              "must have required property '" + "author_response_ratio" + "'",
          };
          if (vErrors === null) {
            vErrors = [err598];
          } else {
            vErrors.push(err598);
          }
          errors++;
        }
        for (const key42 in data247) {
          if (!func1.call(schema32.properties.lineage.properties, key42)) {
            const err599 = {
              instancePath: instancePath + "/lineage",
              schemaPath: "#/properties/lineage/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key42 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err599];
            } else {
              vErrors.push(err599);
            }
            errors++;
          }
        }
        if (data247.repository !== undefined) {
          let data248 = data247.repository;
          if (typeof data248 === "string") {
            if (func2(data248) < 1) {
              const err600 = {
                instancePath: instancePath + "/lineage/repository",
                schemaPath:
                  "#/properties/lineage/properties/repository/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err600];
              } else {
                vErrors.push(err600);
              }
              errors++;
            }
          } else {
            const err601 = {
              instancePath: instancePath + "/lineage/repository",
              schemaPath: "#/properties/lineage/properties/repository/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err601];
            } else {
              vErrors.push(err601);
            }
            errors++;
          }
        }
        if (data247.kind !== undefined) {
          let data249 = data247.kind;
          if (!(data249 === "pr" || data249 === "branch")) {
            const err602 = {
              instancePath: instancePath + "/lineage/kind",
              schemaPath: "#/properties/lineage/properties/kind/enum",
              keyword: "enum",
              params: {
                allowedValues: schema32.properties.lineage.properties.kind.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err602];
            } else {
              vErrors.push(err602);
            }
            errors++;
          }
        }
        if (data247.ref !== undefined) {
          let data250 = data247.ref;
          if (typeof data250 === "string") {
            if (func2(data250) < 1) {
              const err603 = {
                instancePath: instancePath + "/lineage/ref",
                schemaPath: "#/properties/lineage/properties/ref/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err603];
              } else {
                vErrors.push(err603);
              }
              errors++;
            }
          } else {
            const err604 = {
              instancePath: instancePath + "/lineage/ref",
              schemaPath: "#/properties/lineage/properties/ref/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err604];
            } else {
              vErrors.push(err604);
            }
            errors++;
          }
        }
        if (data247.generation !== undefined) {
          let data251 = data247.generation;
          if (!(
            typeof data251 == "number" &&
            !(data251 % 1) &&
            !isNaN(data251)
          )) {
            const err605 = {
              instancePath: instancePath + "/lineage/generation",
              schemaPath: "#/properties/lineage/properties/generation/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err605];
            } else {
              vErrors.push(err605);
            }
            errors++;
          }
          if (typeof data251 == "number") {
            if (data251 < 1 || isNaN(data251)) {
              const err606 = {
                instancePath: instancePath + "/lineage/generation",
                schemaPath:
                  "#/properties/lineage/properties/generation/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err606];
              } else {
                vErrors.push(err606);
              }
              errors++;
            }
          }
        }
        if (data247.round !== undefined) {
          let data252 = data247.round;
          if (!(
            typeof data252 == "number" &&
            !(data252 % 1) &&
            !isNaN(data252)
          )) {
            const err607 = {
              instancePath: instancePath + "/lineage/round",
              schemaPath: "#/properties/lineage/properties/round/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err607];
            } else {
              vErrors.push(err607);
            }
            errors++;
          }
          if (typeof data252 == "number") {
            if (data252 < 1 || isNaN(data252)) {
              const err608 = {
                instancePath: instancePath + "/lineage/round",
                schemaPath: "#/properties/lineage/properties/round/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err608];
              } else {
                vErrors.push(err608);
              }
              errors++;
            }
          }
        }
        if (data247.cap !== undefined) {
          let data253 = data247.cap;
          if (!(
            typeof data253 == "number" &&
            !(data253 % 1) &&
            !isNaN(data253)
          )) {
            const err609 = {
              instancePath: instancePath + "/lineage/cap",
              schemaPath: "#/properties/lineage/properties/cap/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err609];
            } else {
              vErrors.push(err609);
            }
            errors++;
          }
          if (typeof data253 == "number") {
            if (data253 < 1 || isNaN(data253)) {
              const err610 = {
                instancePath: instancePath + "/lineage/cap",
                schemaPath: "#/properties/lineage/properties/cap/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err610];
              } else {
                vErrors.push(err610);
              }
              errors++;
            }
          }
        }
        if (data247.capped !== undefined) {
          if (typeof data247.capped !== "boolean") {
            const err611 = {
              instancePath: instancePath + "/lineage/capped",
              schemaPath: "#/properties/lineage/properties/capped/type",
              keyword: "type",
              params: { type: "boolean" },
              message: "must be boolean",
            };
            if (vErrors === null) {
              vErrors = [err611];
            } else {
              vErrors.push(err611);
            }
            errors++;
          }
        }
        if (data247.diff_only !== undefined) {
          if (typeof data247.diff_only !== "boolean") {
            const err612 = {
              instancePath: instancePath + "/lineage/diff_only",
              schemaPath: "#/properties/lineage/properties/diff_only/type",
              keyword: "type",
              params: { type: "boolean" },
              message: "must be boolean",
            };
            if (vErrors === null) {
              vErrors = [err612];
            } else {
              vErrors.push(err612);
            }
            errors++;
          }
        }
        if (data247.previous_head !== undefined) {
          let data256 = data247.previous_head;
          if (typeof data256 !== "string" && data256 !== null) {
            const err613 = {
              instancePath: instancePath + "/lineage/previous_head",
              schemaPath: "#/properties/lineage/properties/previous_head/type",
              keyword: "type",
              params: {
                type: schema32.properties.lineage.properties.previous_head.type,
              },
              message: "must be string,null",
            };
            if (vErrors === null) {
              vErrors = [err613];
            } else {
              vErrors.push(err613);
            }
            errors++;
          }
        }
        if (data247.held_back !== undefined) {
          let data257 = data247.held_back;
          if (!(
            typeof data257 == "number" &&
            !(data257 % 1) &&
            !isNaN(data257)
          )) {
            const err614 = {
              instancePath: instancePath + "/lineage/held_back",
              schemaPath: "#/properties/lineage/properties/held_back/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err614];
            } else {
              vErrors.push(err614);
            }
            errors++;
          }
          if (typeof data257 == "number") {
            if (data257 < 0 || isNaN(data257)) {
              const err615 = {
                instancePath: instancePath + "/lineage/held_back",
                schemaPath: "#/properties/lineage/properties/held_back/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err615];
              } else {
                vErrors.push(err615);
              }
              errors++;
            }
          }
        }
        if (data247.rounds_to_pass !== undefined) {
          let data258 = data247.rounds_to_pass;
          if (
            !(
              typeof data258 == "number" &&
              !(data258 % 1) &&
              !isNaN(data258)
            ) &&
            data258 !== null
          ) {
            const err616 = {
              instancePath: instancePath + "/lineage/rounds_to_pass",
              schemaPath: "#/properties/lineage/properties/rounds_to_pass/type",
              keyword: "type",
              params: {
                type: schema32.properties.lineage.properties.rounds_to_pass
                  .type,
              },
              message: "must be integer,null",
            };
            if (vErrors === null) {
              vErrors = [err616];
            } else {
              vErrors.push(err616);
            }
            errors++;
          }
          if (typeof data258 == "number") {
            if (data258 < 1 || isNaN(data258)) {
              const err617 = {
                instancePath: instancePath + "/lineage/rounds_to_pass",
                schemaPath:
                  "#/properties/lineage/properties/rounds_to_pass/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err617];
              } else {
                vErrors.push(err617);
              }
              errors++;
            }
          }
        }
        if (data247.author_response_ratio !== undefined) {
          let data259 = data247.author_response_ratio;
          if (!(typeof data259 == "number") && data259 !== null) {
            const err618 = {
              instancePath: instancePath + "/lineage/author_response_ratio",
              schemaPath:
                "#/properties/lineage/properties/author_response_ratio/type",
              keyword: "type",
              params: {
                type: schema32.properties.lineage.properties
                  .author_response_ratio.type,
              },
              message: "must be number,null",
            };
            if (vErrors === null) {
              vErrors = [err618];
            } else {
              vErrors.push(err618);
            }
            errors++;
          }
          if (typeof data259 == "number") {
            if (data259 > 1 || isNaN(data259)) {
              const err619 = {
                instancePath: instancePath + "/lineage/author_response_ratio",
                schemaPath:
                  "#/properties/lineage/properties/author_response_ratio/maximum",
                keyword: "maximum",
                params: { comparison: "<=", limit: 1 },
                message: "must be <= 1",
              };
              if (vErrors === null) {
                vErrors = [err619];
              } else {
                vErrors.push(err619);
              }
              errors++;
            }
            if (data259 < 0 || isNaN(data259)) {
              const err620 = {
                instancePath: instancePath + "/lineage/author_response_ratio",
                schemaPath:
                  "#/properties/lineage/properties/author_response_ratio/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err620];
              } else {
                vErrors.push(err620);
              }
              errors++;
            }
          }
        }
        if (data247.reconsider !== undefined) {
          let data260 = data247.reconsider;
          if (
            data260 &&
            typeof data260 == "object" &&
            !Array.isArray(data260)
          ) {
            if (data260.unresolved === undefined) {
              const err621 = {
                instancePath: instancePath + "/lineage/reconsider",
                schemaPath:
                  "#/properties/lineage/properties/reconsider/required",
                keyword: "required",
                params: { missingProperty: "unresolved" },
                message: "must have required property '" + "unresolved" + "'",
              };
              if (vErrors === null) {
                vErrors = [err621];
              } else {
                vErrors.push(err621);
              }
              errors++;
            }
            if (data260.top === undefined) {
              const err622 = {
                instancePath: instancePath + "/lineage/reconsider",
                schemaPath:
                  "#/properties/lineage/properties/reconsider/required",
                keyword: "required",
                params: { missingProperty: "top" },
                message: "must have required property '" + "top" + "'",
              };
              if (vErrors === null) {
                vErrors = [err622];
              } else {
                vErrors.push(err622);
              }
              errors++;
            }
            for (const key43 in data260) {
              if (!(
                key43 === "unresolved" ||
                key43 === "top" ||
                key43 === "split"
              )) {
                const err623 = {
                  instancePath: instancePath + "/lineage/reconsider",
                  schemaPath:
                    "#/properties/lineage/properties/reconsider/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key43 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err623];
                } else {
                  vErrors.push(err623);
                }
                errors++;
              }
            }
            if (data260.unresolved !== undefined) {
              let data261 = data260.unresolved;
              if (!(
                typeof data261 == "number" &&
                !(data261 % 1) &&
                !isNaN(data261)
              )) {
                const err624 = {
                  instancePath: instancePath + "/lineage/reconsider/unresolved",
                  schemaPath:
                    "#/properties/lineage/properties/reconsider/properties/unresolved/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err624];
                } else {
                  vErrors.push(err624);
                }
                errors++;
              }
              if (typeof data261 == "number") {
                if (data261 < 0 || isNaN(data261)) {
                  const err625 = {
                    instancePath:
                      instancePath + "/lineage/reconsider/unresolved",
                    schemaPath:
                      "#/properties/lineage/properties/reconsider/properties/unresolved/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 0 },
                    message: "must be >= 0",
                  };
                  if (vErrors === null) {
                    vErrors = [err625];
                  } else {
                    vErrors.push(err625);
                  }
                  errors++;
                }
              }
            }
            if (data260.top !== undefined) {
              let data262 = data260.top;
              if (Array.isArray(data262)) {
                if (data262.length > 3) {
                  const err626 = {
                    instancePath: instancePath + "/lineage/reconsider/top",
                    schemaPath:
                      "#/properties/lineage/properties/reconsider/properties/top/maxItems",
                    keyword: "maxItems",
                    params: { limit: 3 },
                    message: "must NOT have more than 3 items",
                  };
                  if (vErrors === null) {
                    vErrors = [err626];
                  } else {
                    vErrors.push(err626);
                  }
                  errors++;
                }
                const len27 = data262.length;
                for (let i27 = 0; i27 < len27; i27++) {
                  let data263 = data262[i27];
                  if (
                    data263 &&
                    typeof data263 == "object" &&
                    !Array.isArray(data263)
                  ) {
                    if (data263.id === undefined) {
                      const err627 = {
                        instancePath:
                          instancePath + "/lineage/reconsider/top/" + i27,
                        schemaPath:
                          "#/properties/lineage/properties/reconsider/properties/top/items/required",
                        keyword: "required",
                        params: { missingProperty: "id" },
                        message: "must have required property '" + "id" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err627];
                      } else {
                        vErrors.push(err627);
                      }
                      errors++;
                    }
                    if (data263.title === undefined) {
                      const err628 = {
                        instancePath:
                          instancePath + "/lineage/reconsider/top/" + i27,
                        schemaPath:
                          "#/properties/lineage/properties/reconsider/properties/top/items/required",
                        keyword: "required",
                        params: { missingProperty: "title" },
                        message:
                          "must have required property '" + "title" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err628];
                      } else {
                        vErrors.push(err628);
                      }
                      errors++;
                    }
                    if (data263.path === undefined) {
                      const err629 = {
                        instancePath:
                          instancePath + "/lineage/reconsider/top/" + i27,
                        schemaPath:
                          "#/properties/lineage/properties/reconsider/properties/top/items/required",
                        keyword: "required",
                        params: { missingProperty: "path" },
                        message: "must have required property '" + "path" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err629];
                      } else {
                        vErrors.push(err629);
                      }
                      errors++;
                    }
                    if (data263.line_start === undefined) {
                      const err630 = {
                        instancePath:
                          instancePath + "/lineage/reconsider/top/" + i27,
                        schemaPath:
                          "#/properties/lineage/properties/reconsider/properties/top/items/required",
                        keyword: "required",
                        params: { missingProperty: "line_start" },
                        message:
                          "must have required property '" + "line_start" + "'",
                      };
                      if (vErrors === null) {
                        vErrors = [err630];
                      } else {
                        vErrors.push(err630);
                      }
                      errors++;
                    }
                    for (const key44 in data263) {
                      if (!(
                        key44 === "id" ||
                        key44 === "title" ||
                        key44 === "path" ||
                        key44 === "line_start"
                      )) {
                        const err631 = {
                          instancePath:
                            instancePath + "/lineage/reconsider/top/" + i27,
                          schemaPath:
                            "#/properties/lineage/properties/reconsider/properties/top/items/additionalProperties",
                          keyword: "additionalProperties",
                          params: { additionalProperty: key44 },
                          message: "must NOT have additional properties",
                        };
                        if (vErrors === null) {
                          vErrors = [err631];
                        } else {
                          vErrors.push(err631);
                        }
                        errors++;
                      }
                    }
                    if (data263.id !== undefined) {
                      if (typeof data263.id !== "string") {
                        const err632 = {
                          instancePath:
                            instancePath +
                            "/lineage/reconsider/top/" +
                            i27 +
                            "/id",
                          schemaPath:
                            "#/properties/lineage/properties/reconsider/properties/top/items/properties/id/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err632];
                        } else {
                          vErrors.push(err632);
                        }
                        errors++;
                      }
                    }
                    if (data263.title !== undefined) {
                      if (typeof data263.title !== "string") {
                        const err633 = {
                          instancePath:
                            instancePath +
                            "/lineage/reconsider/top/" +
                            i27 +
                            "/title",
                          schemaPath:
                            "#/properties/lineage/properties/reconsider/properties/top/items/properties/title/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err633];
                        } else {
                          vErrors.push(err633);
                        }
                        errors++;
                      }
                    }
                    if (data263.path !== undefined) {
                      if (typeof data263.path !== "string") {
                        const err634 = {
                          instancePath:
                            instancePath +
                            "/lineage/reconsider/top/" +
                            i27 +
                            "/path",
                          schemaPath:
                            "#/properties/lineage/properties/reconsider/properties/top/items/properties/path/type",
                          keyword: "type",
                          params: { type: "string" },
                          message: "must be string",
                        };
                        if (vErrors === null) {
                          vErrors = [err634];
                        } else {
                          vErrors.push(err634);
                        }
                        errors++;
                      }
                    }
                    if (data263.line_start !== undefined) {
                      let data267 = data263.line_start;
                      if (!(
                        typeof data267 == "number" &&
                        !(data267 % 1) &&
                        !isNaN(data267)
                      )) {
                        const err635 = {
                          instancePath:
                            instancePath +
                            "/lineage/reconsider/top/" +
                            i27 +
                            "/line_start",
                          schemaPath:
                            "#/properties/lineage/properties/reconsider/properties/top/items/properties/line_start/type",
                          keyword: "type",
                          params: { type: "integer" },
                          message: "must be integer",
                        };
                        if (vErrors === null) {
                          vErrors = [err635];
                        } else {
                          vErrors.push(err635);
                        }
                        errors++;
                      }
                      if (typeof data267 == "number") {
                        if (data267 < 1 || isNaN(data267)) {
                          const err636 = {
                            instancePath:
                              instancePath +
                              "/lineage/reconsider/top/" +
                              i27 +
                              "/line_start",
                            schemaPath:
                              "#/properties/lineage/properties/reconsider/properties/top/items/properties/line_start/minimum",
                            keyword: "minimum",
                            params: { comparison: ">=", limit: 1 },
                            message: "must be >= 1",
                          };
                          if (vErrors === null) {
                            vErrors = [err636];
                          } else {
                            vErrors.push(err636);
                          }
                          errors++;
                        }
                      }
                    }
                  } else {
                    const err637 = {
                      instancePath:
                        instancePath + "/lineage/reconsider/top/" + i27,
                      schemaPath:
                        "#/properties/lineage/properties/reconsider/properties/top/items/type",
                      keyword: "type",
                      params: { type: "object" },
                      message: "must be object",
                    };
                    if (vErrors === null) {
                      vErrors = [err637];
                    } else {
                      vErrors.push(err637);
                    }
                    errors++;
                  }
                }
              } else {
                const err638 = {
                  instancePath: instancePath + "/lineage/reconsider/top",
                  schemaPath:
                    "#/properties/lineage/properties/reconsider/properties/top/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err638];
                } else {
                  vErrors.push(err638);
                }
                errors++;
              }
            }
            if (data260.split !== undefined) {
              let data268 = data260.split;
              if (Array.isArray(data268)) {
                const len28 = data268.length;
                for (let i28 = 0; i28 < len28; i28++) {
                  let data269 = data268[i28];
                  if (typeof data269 === "string") {
                    if (func2(data269) < 1) {
                      const err639 = {
                        instancePath:
                          instancePath + "/lineage/reconsider/split/" + i28,
                        schemaPath:
                          "#/properties/lineage/properties/reconsider/properties/split/items/minLength",
                        keyword: "minLength",
                        params: { limit: 1 },
                        message: "must NOT have fewer than 1 characters",
                      };
                      if (vErrors === null) {
                        vErrors = [err639];
                      } else {
                        vErrors.push(err639);
                      }
                      errors++;
                    }
                  } else {
                    const err640 = {
                      instancePath:
                        instancePath + "/lineage/reconsider/split/" + i28,
                      schemaPath:
                        "#/properties/lineage/properties/reconsider/properties/split/items/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err640];
                    } else {
                      vErrors.push(err640);
                    }
                    errors++;
                  }
                }
              } else {
                const err641 = {
                  instancePath: instancePath + "/lineage/reconsider/split",
                  schemaPath:
                    "#/properties/lineage/properties/reconsider/properties/split/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err641];
                } else {
                  vErrors.push(err641);
                }
                errors++;
              }
            }
          } else {
            const err642 = {
              instancePath: instancePath + "/lineage/reconsider",
              schemaPath: "#/properties/lineage/properties/reconsider/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err642];
            } else {
              vErrors.push(err642);
            }
            errors++;
          }
        }
      } else {
        const err643 = {
          instancePath: instancePath + "/lineage",
          schemaPath: "#/properties/lineage/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err643];
        } else {
          vErrors.push(err643);
        }
        errors++;
      }
    }
  } else {
    const err644 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err644];
    } else {
      vErrors.push(err644);
    }
    errors++;
  }
  validate21.errors = vErrors;
  return errors === 0;
}
validate21.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const finding = validate25;
const schema38 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://rio.dev/schemas/finding-v1.json",
  title: "Rio finding v1",
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-f0-9]{64}$" },
    rule_id: { type: "string", minLength: 1 },
    category: { enum: ["defect", "risk", "security"] },
    evidence_level: {
      enum: ["reproduced", "static_proven", "plausible", "refuted"],
    },
    severity: { enum: ["error", "warning", "info"] },
    state: {
      enum: ["new", "worsened", "pre-existing", "fixed", "unclassified"],
    },
    location: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
        },
        line_start: { type: "integer", minimum: 1 },
        line_end: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        symbol_path: { type: "string" },
        occurrence_state: {
          enum: ["new", "pre-existing", "fixed", "unclassified"],
        },
      },
      required: [
        "path",
        "line_start",
        "line_end",
        "symbol_path",
        "occurrence_state",
      ],
      additionalProperties: false,
    },
    message: { type: "string", minLength: 1 },
    trigger: { type: "string" },
    impact: { type: "string", minLength: 1 },
    suggested_fix: { type: "string", minLength: 1 },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
    source: {
      oneOf: [
        {
          type: "object",
          properties: {
            tool: { type: "string", minLength: 1 },
            version: { type: "string", minLength: 1 },
          },
          required: ["tool", "version"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { agent: { type: "string", minLength: 1 } },
          required: ["agent"],
          additionalProperties: false,
        },
      ],
    },
    locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
          },
          line_start: { type: "integer", minimum: 1 },
          line_end: { type: "integer", minimum: 1 },
          column: { type: "integer", minimum: 1 },
          symbol_path: { type: "string" },
          occurrence_state: {
            enum: ["new", "pre-existing", "fixed", "unclassified"],
          },
          id: {
            description:
              "Identity of the instance finding when this location belongs to a class-level finding.",
            type: "string",
            minLength: 1,
          },
        },
        required: [
          "path",
          "line_start",
          "line_end",
          "symbol_path",
          "occurrence_state",
        ],
        additionalProperties: false,
      },
      minItems: 1,
    },
    advisory: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        aliases: { type: "array", items: { type: "string", minLength: 1 } },
        severity: { enum: ["critical", "high", "moderate", "low", "unknown"] },
        fixed_version: { type: "string", minLength: 1 },
        url: { type: "string", pattern: "^https://" },
      },
      required: ["id", "aliases", "severity", "fixed_version", "url"],
      additionalProperties: false,
    },
    round: { type: "integer", minimum: 1 },
    first_posted_in: { type: "string", minLength: 1 },
    author_response: {
      type: "object",
      properties: {
        reason: {
          enum: ["fixed", "wrong", "intentional", "irrelevant", "style"],
        },
        actor: { type: "string", minLength: 1 },
        at: { type: "string", format: "date-time" },
        note: { type: "string" },
      },
      required: ["reason", "actor", "at"],
      additionalProperties: false,
    },
    status: {
      description:
        "Lifecycle of a posted lineage finding, independent of regression state.",
      enum: ["open", "fixed", "dismissed"],
    },
    resolution: {
      description:
        "How the lifecycle status was reached: the head that fixed the finding, or why it stayed open.",
      type: "object",
      properties: {
        fixed_in: { type: "string", minLength: 1 },
        note: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    verification: {
      type: "object",
      properties: {
        voters: { type: "integer", minimum: 1 },
        agreeing: { type: "integer", minimum: 0 },
        blind_match: {
          type: "array",
          items: { enum: ["same", "related", "none"] },
        },
        split: { type: "boolean" },
      },
      required: ["voters", "agreeing", "blind_match", "split"],
      additionalProperties: false,
      description:
        "Semantic invariant: agreeing <= voters and blind_match contains one entry per configured voter; enforced by Rio deserialization and runtime validation.",
    },
  },
  required: [
    "id",
    "rule_id",
    "category",
    "evidence_level",
    "severity",
    "state",
    "location",
    "message",
    "trigger",
    "evidence",
    "source",
    "locations",
  ],
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { rule_id: { pattern: "^dependency/" } } },
      then: { required: ["advisory"] },
    },
  ],
};
function validate25(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  /*# sourceURL="https://rio.dev/schemas/finding-v1.json" */ let vErrors = null;
  let errors = 0;
  const evaluated0 = validate25.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  const _errs2 = errors;
  let valid1 = true;
  const _errs3 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.rule_id !== undefined) {
      let data0 = data.rule_id;
      if (typeof data0 === "string") {
        if (!pattern6.test(data0)) {
          const err0 = {};
          if (vErrors === null) {
            vErrors = [err0];
          } else {
            vErrors.push(err0);
          }
          errors++;
        }
      }
    }
  }
  var _valid0 = _errs3 === errors;
  errors = _errs2;
  if (vErrors !== null) {
    if (_errs2) {
      vErrors.length = _errs2;
    } else {
      vErrors = null;
    }
  }
  if (_valid0) {
    const _errs5 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.advisory === undefined) {
        const err1 = {
          instancePath,
          schemaPath: "#/allOf/0/then/required",
          keyword: "required",
          params: { missingProperty: "advisory" },
          message: "must have required property '" + "advisory" + "'",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    var _valid0 = _errs5 === errors;
    valid1 = _valid0;
  }
  if (!valid1) {
    const err2 = {
      instancePath,
      schemaPath: "#/allOf/0/if",
      keyword: "if",
      params: { failingKeyword: "then" },
      message: 'must match "then" schema',
    };
    if (vErrors === null) {
      vErrors = [err2];
    } else {
      vErrors.push(err2);
    }
    errors++;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === undefined) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "id" },
        message: "must have required property '" + "id" + "'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.rule_id === undefined) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "rule_id" },
        message: "must have required property '" + "rule_id" + "'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.category === undefined) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "category" },
        message: "must have required property '" + "category" + "'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.evidence_level === undefined) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "evidence_level" },
        message: "must have required property '" + "evidence_level" + "'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.severity === undefined) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "severity" },
        message: "must have required property '" + "severity" + "'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.state === undefined) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "state" },
        message: "must have required property '" + "state" + "'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (data.location === undefined) {
      const err9 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "location" },
        message: "must have required property '" + "location" + "'",
      };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    if (data.message === undefined) {
      const err10 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "message" },
        message: "must have required property '" + "message" + "'",
      };
      if (vErrors === null) {
        vErrors = [err10];
      } else {
        vErrors.push(err10);
      }
      errors++;
    }
    if (data.trigger === undefined) {
      const err11 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "trigger" },
        message: "must have required property '" + "trigger" + "'",
      };
      if (vErrors === null) {
        vErrors = [err11];
      } else {
        vErrors.push(err11);
      }
      errors++;
    }
    if (data.evidence === undefined) {
      const err12 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "evidence" },
        message: "must have required property '" + "evidence" + "'",
      };
      if (vErrors === null) {
        vErrors = [err12];
      } else {
        vErrors.push(err12);
      }
      errors++;
    }
    if (data.source === undefined) {
      const err13 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "source" },
        message: "must have required property '" + "source" + "'",
      };
      if (vErrors === null) {
        vErrors = [err13];
      } else {
        vErrors.push(err13);
      }
      errors++;
    }
    if (data.locations === undefined) {
      const err14 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "locations" },
        message: "must have required property '" + "locations" + "'",
      };
      if (vErrors === null) {
        vErrors = [err14];
      } else {
        vErrors.push(err14);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema38.properties, key0)) {
        const err15 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.id !== undefined) {
      let data1 = data.id;
      if (typeof data1 === "string") {
        if (!pattern7.test(data1)) {
          const err16 = {
            instancePath: instancePath + "/id",
            schemaPath: "#/properties/id/pattern",
            keyword: "pattern",
            params: { pattern: "^[a-f0-9]{64}$" },
            message: 'must match pattern "' + "^[a-f0-9]{64}$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
      } else {
        const err17 = {
          instancePath: instancePath + "/id",
          schemaPath: "#/properties/id/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
    if (data.rule_id !== undefined) {
      let data2 = data.rule_id;
      if (typeof data2 === "string") {
        if (func2(data2) < 1) {
          const err18 = {
            instancePath: instancePath + "/rule_id",
            schemaPath: "#/properties/rule_id/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
      } else {
        const err19 = {
          instancePath: instancePath + "/rule_id",
          schemaPath: "#/properties/rule_id/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
    }
    if (data.category !== undefined) {
      let data3 = data.category;
      if (!(data3 === "defect" || data3 === "risk" || data3 === "security")) {
        const err20 = {
          instancePath: instancePath + "/category",
          schemaPath: "#/properties/category/enum",
          keyword: "enum",
          params: { allowedValues: schema38.properties.category.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
    }
    if (data.evidence_level !== undefined) {
      let data4 = data.evidence_level;
      if (!(
        data4 === "reproduced" ||
        data4 === "static_proven" ||
        data4 === "plausible" ||
        data4 === "refuted"
      )) {
        const err21 = {
          instancePath: instancePath + "/evidence_level",
          schemaPath: "#/properties/evidence_level/enum",
          keyword: "enum",
          params: { allowedValues: schema38.properties.evidence_level.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err21];
        } else {
          vErrors.push(err21);
        }
        errors++;
      }
    }
    if (data.severity !== undefined) {
      let data5 = data.severity;
      if (!(data5 === "error" || data5 === "warning" || data5 === "info")) {
        const err22 = {
          instancePath: instancePath + "/severity",
          schemaPath: "#/properties/severity/enum",
          keyword: "enum",
          params: { allowedValues: schema38.properties.severity.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err22];
        } else {
          vErrors.push(err22);
        }
        errors++;
      }
    }
    if (data.state !== undefined) {
      let data6 = data.state;
      if (!(
        data6 === "new" ||
        data6 === "worsened" ||
        data6 === "pre-existing" ||
        data6 === "fixed" ||
        data6 === "unclassified"
      )) {
        const err23 = {
          instancePath: instancePath + "/state",
          schemaPath: "#/properties/state/enum",
          keyword: "enum",
          params: { allowedValues: schema38.properties.state.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
    }
    if (data.location !== undefined) {
      let data7 = data.location;
      if (data7 && typeof data7 == "object" && !Array.isArray(data7)) {
        if (data7.path === undefined) {
          const err24 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "path" },
            message: "must have required property '" + "path" + "'",
          };
          if (vErrors === null) {
            vErrors = [err24];
          } else {
            vErrors.push(err24);
          }
          errors++;
        }
        if (data7.line_start === undefined) {
          const err25 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "line_start" },
            message: "must have required property '" + "line_start" + "'",
          };
          if (vErrors === null) {
            vErrors = [err25];
          } else {
            vErrors.push(err25);
          }
          errors++;
        }
        if (data7.line_end === undefined) {
          const err26 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "line_end" },
            message: "must have required property '" + "line_end" + "'",
          };
          if (vErrors === null) {
            vErrors = [err26];
          } else {
            vErrors.push(err26);
          }
          errors++;
        }
        if (data7.symbol_path === undefined) {
          const err27 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "symbol_path" },
            message: "must have required property '" + "symbol_path" + "'",
          };
          if (vErrors === null) {
            vErrors = [err27];
          } else {
            vErrors.push(err27);
          }
          errors++;
        }
        if (data7.occurrence_state === undefined) {
          const err28 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "occurrence_state" },
            message: "must have required property '" + "occurrence_state" + "'",
          };
          if (vErrors === null) {
            vErrors = [err28];
          } else {
            vErrors.push(err28);
          }
          errors++;
        }
        for (const key1 in data7) {
          if (!(
            key1 === "path" ||
            key1 === "line_start" ||
            key1 === "line_end" ||
            key1 === "column" ||
            key1 === "symbol_path" ||
            key1 === "occurrence_state"
          )) {
            const err29 = {
              instancePath: instancePath + "/location",
              schemaPath: "#/properties/location/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key1 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err29];
            } else {
              vErrors.push(err29);
            }
            errors++;
          }
        }
        if (data7.path !== undefined) {
          let data8 = data7.path;
          if (typeof data8 === "string") {
            if (func2(data8) < 1) {
              const err30 = {
                instancePath: instancePath + "/location/path",
                schemaPath: "#/properties/location/properties/path/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err30];
              } else {
                vErrors.push(err30);
              }
              errors++;
            }
            if (!pattern8.test(data8)) {
              const err31 = {
                instancePath: instancePath + "/location/path",
                schemaPath: "#/properties/location/properties/path/pattern",
                keyword: "pattern",
                params: {
                  pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                },
                message:
                  'must match pattern "' +
                  "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                  '"',
              };
              if (vErrors === null) {
                vErrors = [err31];
              } else {
                vErrors.push(err31);
              }
              errors++;
            }
          } else {
            const err32 = {
              instancePath: instancePath + "/location/path",
              schemaPath: "#/properties/location/properties/path/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err32];
            } else {
              vErrors.push(err32);
            }
            errors++;
          }
        }
        if (data7.line_start !== undefined) {
          let data9 = data7.line_start;
          if (!(typeof data9 == "number" && !(data9 % 1) && !isNaN(data9))) {
            const err33 = {
              instancePath: instancePath + "/location/line_start",
              schemaPath: "#/properties/location/properties/line_start/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err33];
            } else {
              vErrors.push(err33);
            }
            errors++;
          }
          if (typeof data9 == "number") {
            if (data9 < 1 || isNaN(data9)) {
              const err34 = {
                instancePath: instancePath + "/location/line_start",
                schemaPath:
                  "#/properties/location/properties/line_start/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err34];
              } else {
                vErrors.push(err34);
              }
              errors++;
            }
          }
        }
        if (data7.line_end !== undefined) {
          let data10 = data7.line_end;
          if (!(typeof data10 == "number" && !(data10 % 1) && !isNaN(data10))) {
            const err35 = {
              instancePath: instancePath + "/location/line_end",
              schemaPath: "#/properties/location/properties/line_end/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err35];
            } else {
              vErrors.push(err35);
            }
            errors++;
          }
          if (typeof data10 == "number") {
            if (data10 < 1 || isNaN(data10)) {
              const err36 = {
                instancePath: instancePath + "/location/line_end",
                schemaPath: "#/properties/location/properties/line_end/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err36];
              } else {
                vErrors.push(err36);
              }
              errors++;
            }
          }
        }
        if (data7.column !== undefined) {
          let data11 = data7.column;
          if (!(typeof data11 == "number" && !(data11 % 1) && !isNaN(data11))) {
            const err37 = {
              instancePath: instancePath + "/location/column",
              schemaPath: "#/properties/location/properties/column/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err37];
            } else {
              vErrors.push(err37);
            }
            errors++;
          }
          if (typeof data11 == "number") {
            if (data11 < 1 || isNaN(data11)) {
              const err38 = {
                instancePath: instancePath + "/location/column",
                schemaPath: "#/properties/location/properties/column/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err38];
              } else {
                vErrors.push(err38);
              }
              errors++;
            }
          }
        }
        if (data7.symbol_path !== undefined) {
          if (typeof data7.symbol_path !== "string") {
            const err39 = {
              instancePath: instancePath + "/location/symbol_path",
              schemaPath: "#/properties/location/properties/symbol_path/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err39];
            } else {
              vErrors.push(err39);
            }
            errors++;
          }
        }
        if (data7.occurrence_state !== undefined) {
          let data13 = data7.occurrence_state;
          if (!(
            data13 === "new" ||
            data13 === "pre-existing" ||
            data13 === "fixed" ||
            data13 === "unclassified"
          )) {
            const err40 = {
              instancePath: instancePath + "/location/occurrence_state",
              schemaPath:
                "#/properties/location/properties/occurrence_state/enum",
              keyword: "enum",
              params: {
                allowedValues:
                  schema38.properties.location.properties.occurrence_state.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err40];
            } else {
              vErrors.push(err40);
            }
            errors++;
          }
        }
      } else {
        const err41 = {
          instancePath: instancePath + "/location",
          schemaPath: "#/properties/location/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err41];
        } else {
          vErrors.push(err41);
        }
        errors++;
      }
    }
    if (data.message !== undefined) {
      let data14 = data.message;
      if (typeof data14 === "string") {
        if (func2(data14) < 1) {
          const err42 = {
            instancePath: instancePath + "/message",
            schemaPath: "#/properties/message/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err42];
          } else {
            vErrors.push(err42);
          }
          errors++;
        }
      } else {
        const err43 = {
          instancePath: instancePath + "/message",
          schemaPath: "#/properties/message/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err43];
        } else {
          vErrors.push(err43);
        }
        errors++;
      }
    }
    if (data.trigger !== undefined) {
      if (typeof data.trigger !== "string") {
        const err44 = {
          instancePath: instancePath + "/trigger",
          schemaPath: "#/properties/trigger/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err44];
        } else {
          vErrors.push(err44);
        }
        errors++;
      }
    }
    if (data.impact !== undefined) {
      let data16 = data.impact;
      if (typeof data16 === "string") {
        if (func2(data16) < 1) {
          const err45 = {
            instancePath: instancePath + "/impact",
            schemaPath: "#/properties/impact/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err45];
          } else {
            vErrors.push(err45);
          }
          errors++;
        }
      } else {
        const err46 = {
          instancePath: instancePath + "/impact",
          schemaPath: "#/properties/impact/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err46];
        } else {
          vErrors.push(err46);
        }
        errors++;
      }
    }
    if (data.suggested_fix !== undefined) {
      let data17 = data.suggested_fix;
      if (typeof data17 === "string") {
        if (func2(data17) < 1) {
          const err47 = {
            instancePath: instancePath + "/suggested_fix",
            schemaPath: "#/properties/suggested_fix/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err47];
          } else {
            vErrors.push(err47);
          }
          errors++;
        }
      } else {
        const err48 = {
          instancePath: instancePath + "/suggested_fix",
          schemaPath: "#/properties/suggested_fix/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err48];
        } else {
          vErrors.push(err48);
        }
        errors++;
      }
    }
    if (data.evidence !== undefined) {
      let data18 = data.evidence;
      if (Array.isArray(data18)) {
        const len0 = data18.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data19 = data18[i0];
          if (typeof data19 === "string") {
            if (func2(data19) < 1) {
              const err49 = {
                instancePath: instancePath + "/evidence/" + i0,
                schemaPath: "#/properties/evidence/items/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err49];
              } else {
                vErrors.push(err49);
              }
              errors++;
            }
          } else {
            const err50 = {
              instancePath: instancePath + "/evidence/" + i0,
              schemaPath: "#/properties/evidence/items/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err50];
            } else {
              vErrors.push(err50);
            }
            errors++;
          }
        }
      } else {
        const err51 = {
          instancePath: instancePath + "/evidence",
          schemaPath: "#/properties/evidence/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err51];
        } else {
          vErrors.push(err51);
        }
        errors++;
      }
    }
    if (data.source !== undefined) {
      let data20 = data.source;
      const _errs42 = errors;
      let valid7 = false;
      let passing0 = null;
      const _errs43 = errors;
      if (data20 && typeof data20 == "object" && !Array.isArray(data20)) {
        if (data20.tool === undefined) {
          const err52 = {
            instancePath: instancePath + "/source",
            schemaPath: "#/properties/source/oneOf/0/required",
            keyword: "required",
            params: { missingProperty: "tool" },
            message: "must have required property '" + "tool" + "'",
          };
          if (vErrors === null) {
            vErrors = [err52];
          } else {
            vErrors.push(err52);
          }
          errors++;
        }
        if (data20.version === undefined) {
          const err53 = {
            instancePath: instancePath + "/source",
            schemaPath: "#/properties/source/oneOf/0/required",
            keyword: "required",
            params: { missingProperty: "version" },
            message: "must have required property '" + "version" + "'",
          };
          if (vErrors === null) {
            vErrors = [err53];
          } else {
            vErrors.push(err53);
          }
          errors++;
        }
        for (const key2 in data20) {
          if (!(key2 === "tool" || key2 === "version")) {
            const err54 = {
              instancePath: instancePath + "/source",
              schemaPath: "#/properties/source/oneOf/0/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key2 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err54];
            } else {
              vErrors.push(err54);
            }
            errors++;
          }
        }
        if (data20.tool !== undefined) {
          let data21 = data20.tool;
          if (typeof data21 === "string") {
            if (func2(data21) < 1) {
              const err55 = {
                instancePath: instancePath + "/source/tool",
                schemaPath:
                  "#/properties/source/oneOf/0/properties/tool/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err55];
              } else {
                vErrors.push(err55);
              }
              errors++;
            }
          } else {
            const err56 = {
              instancePath: instancePath + "/source/tool",
              schemaPath: "#/properties/source/oneOf/0/properties/tool/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err56];
            } else {
              vErrors.push(err56);
            }
            errors++;
          }
        }
        if (data20.version !== undefined) {
          let data22 = data20.version;
          if (typeof data22 === "string") {
            if (func2(data22) < 1) {
              const err57 = {
                instancePath: instancePath + "/source/version",
                schemaPath:
                  "#/properties/source/oneOf/0/properties/version/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err57];
              } else {
                vErrors.push(err57);
              }
              errors++;
            }
          } else {
            const err58 = {
              instancePath: instancePath + "/source/version",
              schemaPath: "#/properties/source/oneOf/0/properties/version/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err58];
            } else {
              vErrors.push(err58);
            }
            errors++;
          }
        }
      } else {
        const err59 = {
          instancePath: instancePath + "/source",
          schemaPath: "#/properties/source/oneOf/0/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err59];
        } else {
          vErrors.push(err59);
        }
        errors++;
      }
      var _valid1 = _errs43 === errors;
      if (_valid1) {
        valid7 = true;
        passing0 = 0;
        var props0 = true;
      }
      const _errs50 = errors;
      if (data20 && typeof data20 == "object" && !Array.isArray(data20)) {
        if (data20.agent === undefined) {
          const err60 = {
            instancePath: instancePath + "/source",
            schemaPath: "#/properties/source/oneOf/1/required",
            keyword: "required",
            params: { missingProperty: "agent" },
            message: "must have required property '" + "agent" + "'",
          };
          if (vErrors === null) {
            vErrors = [err60];
          } else {
            vErrors.push(err60);
          }
          errors++;
        }
        for (const key3 in data20) {
          if (!(key3 === "agent")) {
            const err61 = {
              instancePath: instancePath + "/source",
              schemaPath: "#/properties/source/oneOf/1/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key3 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err61];
            } else {
              vErrors.push(err61);
            }
            errors++;
          }
        }
        if (data20.agent !== undefined) {
          let data23 = data20.agent;
          if (typeof data23 === "string") {
            if (func2(data23) < 1) {
              const err62 = {
                instancePath: instancePath + "/source/agent",
                schemaPath:
                  "#/properties/source/oneOf/1/properties/agent/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err62];
              } else {
                vErrors.push(err62);
              }
              errors++;
            }
          } else {
            const err63 = {
              instancePath: instancePath + "/source/agent",
              schemaPath: "#/properties/source/oneOf/1/properties/agent/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err63];
            } else {
              vErrors.push(err63);
            }
            errors++;
          }
        }
      } else {
        const err64 = {
          instancePath: instancePath + "/source",
          schemaPath: "#/properties/source/oneOf/1/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err64];
        } else {
          vErrors.push(err64);
        }
        errors++;
      }
      var _valid1 = _errs50 === errors;
      if (_valid1 && valid7) {
        valid7 = false;
        passing0 = [passing0, 1];
      } else {
        if (_valid1) {
          valid7 = true;
          passing0 = 1;
          if (props0 !== true) {
            props0 = true;
          }
        }
      }
      if (!valid7) {
        const err65 = {
          instancePath: instancePath + "/source",
          schemaPath: "#/properties/source/oneOf",
          keyword: "oneOf",
          params: { passingSchemas: passing0 },
          message: "must match exactly one schema in oneOf",
        };
        if (vErrors === null) {
          vErrors = [err65];
        } else {
          vErrors.push(err65);
        }
        errors++;
      } else {
        errors = _errs42;
        if (vErrors !== null) {
          if (_errs42) {
            vErrors.length = _errs42;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.locations !== undefined) {
      let data24 = data.locations;
      if (Array.isArray(data24)) {
        if (data24.length < 1) {
          const err66 = {
            instancePath: instancePath + "/locations",
            schemaPath: "#/properties/locations/minItems",
            keyword: "minItems",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 items",
          };
          if (vErrors === null) {
            vErrors = [err66];
          } else {
            vErrors.push(err66);
          }
          errors++;
        }
        const len1 = data24.length;
        for (let i1 = 0; i1 < len1; i1++) {
          let data25 = data24[i1];
          if (data25 && typeof data25 == "object" && !Array.isArray(data25)) {
            if (data25.path === undefined) {
              const err67 = {
                instancePath: instancePath + "/locations/" + i1,
                schemaPath: "#/properties/locations/items/required",
                keyword: "required",
                params: { missingProperty: "path" },
                message: "must have required property '" + "path" + "'",
              };
              if (vErrors === null) {
                vErrors = [err67];
              } else {
                vErrors.push(err67);
              }
              errors++;
            }
            if (data25.line_start === undefined) {
              const err68 = {
                instancePath: instancePath + "/locations/" + i1,
                schemaPath: "#/properties/locations/items/required",
                keyword: "required",
                params: { missingProperty: "line_start" },
                message: "must have required property '" + "line_start" + "'",
              };
              if (vErrors === null) {
                vErrors = [err68];
              } else {
                vErrors.push(err68);
              }
              errors++;
            }
            if (data25.line_end === undefined) {
              const err69 = {
                instancePath: instancePath + "/locations/" + i1,
                schemaPath: "#/properties/locations/items/required",
                keyword: "required",
                params: { missingProperty: "line_end" },
                message: "must have required property '" + "line_end" + "'",
              };
              if (vErrors === null) {
                vErrors = [err69];
              } else {
                vErrors.push(err69);
              }
              errors++;
            }
            if (data25.symbol_path === undefined) {
              const err70 = {
                instancePath: instancePath + "/locations/" + i1,
                schemaPath: "#/properties/locations/items/required",
                keyword: "required",
                params: { missingProperty: "symbol_path" },
                message: "must have required property '" + "symbol_path" + "'",
              };
              if (vErrors === null) {
                vErrors = [err70];
              } else {
                vErrors.push(err70);
              }
              errors++;
            }
            if (data25.occurrence_state === undefined) {
              const err71 = {
                instancePath: instancePath + "/locations/" + i1,
                schemaPath: "#/properties/locations/items/required",
                keyword: "required",
                params: { missingProperty: "occurrence_state" },
                message:
                  "must have required property '" + "occurrence_state" + "'",
              };
              if (vErrors === null) {
                vErrors = [err71];
              } else {
                vErrors.push(err71);
              }
              errors++;
            }
            for (const key4 in data25) {
              if (!(
                key4 === "path" ||
                key4 === "line_start" ||
                key4 === "line_end" ||
                key4 === "column" ||
                key4 === "symbol_path" ||
                key4 === "occurrence_state" ||
                key4 === "id"
              )) {
                const err72 = {
                  instancePath: instancePath + "/locations/" + i1,
                  schemaPath:
                    "#/properties/locations/items/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key4 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err72];
                } else {
                  vErrors.push(err72);
                }
                errors++;
              }
            }
            if (data25.path !== undefined) {
              let data26 = data25.path;
              if (typeof data26 === "string") {
                if (func2(data26) < 1) {
                  const err73 = {
                    instancePath: instancePath + "/locations/" + i1 + "/path",
                    schemaPath:
                      "#/properties/locations/items/properties/path/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err73];
                  } else {
                    vErrors.push(err73);
                  }
                  errors++;
                }
                if (!pattern8.test(data26)) {
                  const err74 = {
                    instancePath: instancePath + "/locations/" + i1 + "/path",
                    schemaPath:
                      "#/properties/locations/items/properties/path/pattern",
                    keyword: "pattern",
                    params: {
                      pattern:
                        "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
                    },
                    message:
                      'must match pattern "' +
                      "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" +
                      '"',
                  };
                  if (vErrors === null) {
                    vErrors = [err74];
                  } else {
                    vErrors.push(err74);
                  }
                  errors++;
                }
              } else {
                const err75 = {
                  instancePath: instancePath + "/locations/" + i1 + "/path",
                  schemaPath:
                    "#/properties/locations/items/properties/path/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err75];
                } else {
                  vErrors.push(err75);
                }
                errors++;
              }
            }
            if (data25.line_start !== undefined) {
              let data27 = data25.line_start;
              if (!(
                typeof data27 == "number" &&
                !(data27 % 1) &&
                !isNaN(data27)
              )) {
                const err76 = {
                  instancePath:
                    instancePath + "/locations/" + i1 + "/line_start",
                  schemaPath:
                    "#/properties/locations/items/properties/line_start/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err76];
                } else {
                  vErrors.push(err76);
                }
                errors++;
              }
              if (typeof data27 == "number") {
                if (data27 < 1 || isNaN(data27)) {
                  const err77 = {
                    instancePath:
                      instancePath + "/locations/" + i1 + "/line_start",
                    schemaPath:
                      "#/properties/locations/items/properties/line_start/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err77];
                  } else {
                    vErrors.push(err77);
                  }
                  errors++;
                }
              }
            }
            if (data25.line_end !== undefined) {
              let data28 = data25.line_end;
              if (!(
                typeof data28 == "number" &&
                !(data28 % 1) &&
                !isNaN(data28)
              )) {
                const err78 = {
                  instancePath: instancePath + "/locations/" + i1 + "/line_end",
                  schemaPath:
                    "#/properties/locations/items/properties/line_end/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err78];
                } else {
                  vErrors.push(err78);
                }
                errors++;
              }
              if (typeof data28 == "number") {
                if (data28 < 1 || isNaN(data28)) {
                  const err79 = {
                    instancePath:
                      instancePath + "/locations/" + i1 + "/line_end",
                    schemaPath:
                      "#/properties/locations/items/properties/line_end/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err79];
                  } else {
                    vErrors.push(err79);
                  }
                  errors++;
                }
              }
            }
            if (data25.column !== undefined) {
              let data29 = data25.column;
              if (!(
                typeof data29 == "number" &&
                !(data29 % 1) &&
                !isNaN(data29)
              )) {
                const err80 = {
                  instancePath: instancePath + "/locations/" + i1 + "/column",
                  schemaPath:
                    "#/properties/locations/items/properties/column/type",
                  keyword: "type",
                  params: { type: "integer" },
                  message: "must be integer",
                };
                if (vErrors === null) {
                  vErrors = [err80];
                } else {
                  vErrors.push(err80);
                }
                errors++;
              }
              if (typeof data29 == "number") {
                if (data29 < 1 || isNaN(data29)) {
                  const err81 = {
                    instancePath: instancePath + "/locations/" + i1 + "/column",
                    schemaPath:
                      "#/properties/locations/items/properties/column/minimum",
                    keyword: "minimum",
                    params: { comparison: ">=", limit: 1 },
                    message: "must be >= 1",
                  };
                  if (vErrors === null) {
                    vErrors = [err81];
                  } else {
                    vErrors.push(err81);
                  }
                  errors++;
                }
              }
            }
            if (data25.symbol_path !== undefined) {
              if (typeof data25.symbol_path !== "string") {
                const err82 = {
                  instancePath:
                    instancePath + "/locations/" + i1 + "/symbol_path",
                  schemaPath:
                    "#/properties/locations/items/properties/symbol_path/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err82];
                } else {
                  vErrors.push(err82);
                }
                errors++;
              }
            }
            if (data25.occurrence_state !== undefined) {
              let data31 = data25.occurrence_state;
              if (!(
                data31 === "new" ||
                data31 === "pre-existing" ||
                data31 === "fixed" ||
                data31 === "unclassified"
              )) {
                const err83 = {
                  instancePath:
                    instancePath + "/locations/" + i1 + "/occurrence_state",
                  schemaPath:
                    "#/properties/locations/items/properties/occurrence_state/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema38.properties.locations.items.properties
                        .occurrence_state.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err83];
                } else {
                  vErrors.push(err83);
                }
                errors++;
              }
            }
            if (data25.id !== undefined) {
              let data32 = data25.id;
              if (typeof data32 === "string") {
                if (func2(data32) < 1) {
                  const err84 = {
                    instancePath: instancePath + "/locations/" + i1 + "/id",
                    schemaPath:
                      "#/properties/locations/items/properties/id/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err84];
                  } else {
                    vErrors.push(err84);
                  }
                  errors++;
                }
              } else {
                const err85 = {
                  instancePath: instancePath + "/locations/" + i1 + "/id",
                  schemaPath: "#/properties/locations/items/properties/id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err85];
                } else {
                  vErrors.push(err85);
                }
                errors++;
              }
            }
          } else {
            const err86 = {
              instancePath: instancePath + "/locations/" + i1,
              schemaPath: "#/properties/locations/items/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err86];
            } else {
              vErrors.push(err86);
            }
            errors++;
          }
        }
      } else {
        const err87 = {
          instancePath: instancePath + "/locations",
          schemaPath: "#/properties/locations/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err87];
        } else {
          vErrors.push(err87);
        }
        errors++;
      }
    }
    if (data.advisory !== undefined) {
      let data33 = data.advisory;
      if (data33 && typeof data33 == "object" && !Array.isArray(data33)) {
        if (data33.id === undefined) {
          const err88 = {
            instancePath: instancePath + "/advisory",
            schemaPath: "#/properties/advisory/required",
            keyword: "required",
            params: { missingProperty: "id" },
            message: "must have required property '" + "id" + "'",
          };
          if (vErrors === null) {
            vErrors = [err88];
          } else {
            vErrors.push(err88);
          }
          errors++;
        }
        if (data33.aliases === undefined) {
          const err89 = {
            instancePath: instancePath + "/advisory",
            schemaPath: "#/properties/advisory/required",
            keyword: "required",
            params: { missingProperty: "aliases" },
            message: "must have required property '" + "aliases" + "'",
          };
          if (vErrors === null) {
            vErrors = [err89];
          } else {
            vErrors.push(err89);
          }
          errors++;
        }
        if (data33.severity === undefined) {
          const err90 = {
            instancePath: instancePath + "/advisory",
            schemaPath: "#/properties/advisory/required",
            keyword: "required",
            params: { missingProperty: "severity" },
            message: "must have required property '" + "severity" + "'",
          };
          if (vErrors === null) {
            vErrors = [err90];
          } else {
            vErrors.push(err90);
          }
          errors++;
        }
        if (data33.fixed_version === undefined) {
          const err91 = {
            instancePath: instancePath + "/advisory",
            schemaPath: "#/properties/advisory/required",
            keyword: "required",
            params: { missingProperty: "fixed_version" },
            message: "must have required property '" + "fixed_version" + "'",
          };
          if (vErrors === null) {
            vErrors = [err91];
          } else {
            vErrors.push(err91);
          }
          errors++;
        }
        if (data33.url === undefined) {
          const err92 = {
            instancePath: instancePath + "/advisory",
            schemaPath: "#/properties/advisory/required",
            keyword: "required",
            params: { missingProperty: "url" },
            message: "must have required property '" + "url" + "'",
          };
          if (vErrors === null) {
            vErrors = [err92];
          } else {
            vErrors.push(err92);
          }
          errors++;
        }
        for (const key5 in data33) {
          if (!(
            key5 === "id" ||
            key5 === "aliases" ||
            key5 === "severity" ||
            key5 === "fixed_version" ||
            key5 === "url"
          )) {
            const err93 = {
              instancePath: instancePath + "/advisory",
              schemaPath: "#/properties/advisory/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key5 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err93];
            } else {
              vErrors.push(err93);
            }
            errors++;
          }
        }
        if (data33.id !== undefined) {
          let data34 = data33.id;
          if (typeof data34 === "string") {
            if (func2(data34) < 1) {
              const err94 = {
                instancePath: instancePath + "/advisory/id",
                schemaPath: "#/properties/advisory/properties/id/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err94];
              } else {
                vErrors.push(err94);
              }
              errors++;
            }
          } else {
            const err95 = {
              instancePath: instancePath + "/advisory/id",
              schemaPath: "#/properties/advisory/properties/id/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err95];
            } else {
              vErrors.push(err95);
            }
            errors++;
          }
        }
        if (data33.aliases !== undefined) {
          let data35 = data33.aliases;
          if (Array.isArray(data35)) {
            const len2 = data35.length;
            for (let i2 = 0; i2 < len2; i2++) {
              let data36 = data35[i2];
              if (typeof data36 === "string") {
                if (func2(data36) < 1) {
                  const err96 = {
                    instancePath: instancePath + "/advisory/aliases/" + i2,
                    schemaPath:
                      "#/properties/advisory/properties/aliases/items/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err96];
                  } else {
                    vErrors.push(err96);
                  }
                  errors++;
                }
              } else {
                const err97 = {
                  instancePath: instancePath + "/advisory/aliases/" + i2,
                  schemaPath:
                    "#/properties/advisory/properties/aliases/items/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err97];
                } else {
                  vErrors.push(err97);
                }
                errors++;
              }
            }
          } else {
            const err98 = {
              instancePath: instancePath + "/advisory/aliases",
              schemaPath: "#/properties/advisory/properties/aliases/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err98];
            } else {
              vErrors.push(err98);
            }
            errors++;
          }
        }
        if (data33.severity !== undefined) {
          let data37 = data33.severity;
          if (!(
            data37 === "critical" ||
            data37 === "high" ||
            data37 === "moderate" ||
            data37 === "low" ||
            data37 === "unknown"
          )) {
            const err99 = {
              instancePath: instancePath + "/advisory/severity",
              schemaPath: "#/properties/advisory/properties/severity/enum",
              keyword: "enum",
              params: {
                allowedValues:
                  schema38.properties.advisory.properties.severity.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err99];
            } else {
              vErrors.push(err99);
            }
            errors++;
          }
        }
        if (data33.fixed_version !== undefined) {
          let data38 = data33.fixed_version;
          if (typeof data38 === "string") {
            if (func2(data38) < 1) {
              const err100 = {
                instancePath: instancePath + "/advisory/fixed_version",
                schemaPath:
                  "#/properties/advisory/properties/fixed_version/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err100];
              } else {
                vErrors.push(err100);
              }
              errors++;
            }
          } else {
            const err101 = {
              instancePath: instancePath + "/advisory/fixed_version",
              schemaPath: "#/properties/advisory/properties/fixed_version/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err101];
            } else {
              vErrors.push(err101);
            }
            errors++;
          }
        }
        if (data33.url !== undefined) {
          let data39 = data33.url;
          if (typeof data39 === "string") {
            if (!pattern10.test(data39)) {
              const err102 = {
                instancePath: instancePath + "/advisory/url",
                schemaPath: "#/properties/advisory/properties/url/pattern",
                keyword: "pattern",
                params: { pattern: "^https://" },
                message: 'must match pattern "' + "^https://" + '"',
              };
              if (vErrors === null) {
                vErrors = [err102];
              } else {
                vErrors.push(err102);
              }
              errors++;
            }
          } else {
            const err103 = {
              instancePath: instancePath + "/advisory/url",
              schemaPath: "#/properties/advisory/properties/url/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err103];
            } else {
              vErrors.push(err103);
            }
            errors++;
          }
        }
      } else {
        const err104 = {
          instancePath: instancePath + "/advisory",
          schemaPath: "#/properties/advisory/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err104];
        } else {
          vErrors.push(err104);
        }
        errors++;
      }
    }
    if (data.round !== undefined) {
      let data40 = data.round;
      if (!(typeof data40 == "number" && !(data40 % 1) && !isNaN(data40))) {
        const err105 = {
          instancePath: instancePath + "/round",
          schemaPath: "#/properties/round/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err105];
        } else {
          vErrors.push(err105);
        }
        errors++;
      }
      if (typeof data40 == "number") {
        if (data40 < 1 || isNaN(data40)) {
          const err106 = {
            instancePath: instancePath + "/round",
            schemaPath: "#/properties/round/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 1 },
            message: "must be >= 1",
          };
          if (vErrors === null) {
            vErrors = [err106];
          } else {
            vErrors.push(err106);
          }
          errors++;
        }
      }
    }
    if (data.first_posted_in !== undefined) {
      let data41 = data.first_posted_in;
      if (typeof data41 === "string") {
        if (func2(data41) < 1) {
          const err107 = {
            instancePath: instancePath + "/first_posted_in",
            schemaPath: "#/properties/first_posted_in/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err107];
          } else {
            vErrors.push(err107);
          }
          errors++;
        }
      } else {
        const err108 = {
          instancePath: instancePath + "/first_posted_in",
          schemaPath: "#/properties/first_posted_in/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err108];
        } else {
          vErrors.push(err108);
        }
        errors++;
      }
    }
    if (data.author_response !== undefined) {
      let data42 = data.author_response;
      if (data42 && typeof data42 == "object" && !Array.isArray(data42)) {
        if (data42.reason === undefined) {
          const err109 = {
            instancePath: instancePath + "/author_response",
            schemaPath: "#/properties/author_response/required",
            keyword: "required",
            params: { missingProperty: "reason" },
            message: "must have required property '" + "reason" + "'",
          };
          if (vErrors === null) {
            vErrors = [err109];
          } else {
            vErrors.push(err109);
          }
          errors++;
        }
        if (data42.actor === undefined) {
          const err110 = {
            instancePath: instancePath + "/author_response",
            schemaPath: "#/properties/author_response/required",
            keyword: "required",
            params: { missingProperty: "actor" },
            message: "must have required property '" + "actor" + "'",
          };
          if (vErrors === null) {
            vErrors = [err110];
          } else {
            vErrors.push(err110);
          }
          errors++;
        }
        if (data42.at === undefined) {
          const err111 = {
            instancePath: instancePath + "/author_response",
            schemaPath: "#/properties/author_response/required",
            keyword: "required",
            params: { missingProperty: "at" },
            message: "must have required property '" + "at" + "'",
          };
          if (vErrors === null) {
            vErrors = [err111];
          } else {
            vErrors.push(err111);
          }
          errors++;
        }
        for (const key6 in data42) {
          if (!(
            key6 === "reason" ||
            key6 === "actor" ||
            key6 === "at" ||
            key6 === "note"
          )) {
            const err112 = {
              instancePath: instancePath + "/author_response",
              schemaPath: "#/properties/author_response/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key6 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err112];
            } else {
              vErrors.push(err112);
            }
            errors++;
          }
        }
        if (data42.reason !== undefined) {
          let data43 = data42.reason;
          if (!(
            data43 === "fixed" ||
            data43 === "wrong" ||
            data43 === "intentional" ||
            data43 === "irrelevant" ||
            data43 === "style"
          )) {
            const err113 = {
              instancePath: instancePath + "/author_response/reason",
              schemaPath: "#/properties/author_response/properties/reason/enum",
              keyword: "enum",
              params: {
                allowedValues:
                  schema38.properties.author_response.properties.reason.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err113];
            } else {
              vErrors.push(err113);
            }
            errors++;
          }
        }
        if (data42.actor !== undefined) {
          let data44 = data42.actor;
          if (typeof data44 === "string") {
            if (func2(data44) < 1) {
              const err114 = {
                instancePath: instancePath + "/author_response/actor",
                schemaPath:
                  "#/properties/author_response/properties/actor/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err114];
              } else {
                vErrors.push(err114);
              }
              errors++;
            }
          } else {
            const err115 = {
              instancePath: instancePath + "/author_response/actor",
              schemaPath: "#/properties/author_response/properties/actor/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err115];
            } else {
              vErrors.push(err115);
            }
            errors++;
          }
        }
        if (data42.at !== undefined) {
          let data45 = data42.at;
          if (typeof data45 === "string") {
            if (!formats0.validate(data45)) {
              const err116 = {
                instancePath: instancePath + "/author_response/at",
                schemaPath: "#/properties/author_response/properties/at/format",
                keyword: "format",
                params: { format: "date-time" },
                message: 'must match format "' + "date-time" + '"',
              };
              if (vErrors === null) {
                vErrors = [err116];
              } else {
                vErrors.push(err116);
              }
              errors++;
            }
          } else {
            const err117 = {
              instancePath: instancePath + "/author_response/at",
              schemaPath: "#/properties/author_response/properties/at/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err117];
            } else {
              vErrors.push(err117);
            }
            errors++;
          }
        }
        if (data42.note !== undefined) {
          if (typeof data42.note !== "string") {
            const err118 = {
              instancePath: instancePath + "/author_response/note",
              schemaPath: "#/properties/author_response/properties/note/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err118];
            } else {
              vErrors.push(err118);
            }
            errors++;
          }
        }
      } else {
        const err119 = {
          instancePath: instancePath + "/author_response",
          schemaPath: "#/properties/author_response/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err119];
        } else {
          vErrors.push(err119);
        }
        errors++;
      }
    }
    if (data.status !== undefined) {
      let data47 = data.status;
      if (!(
        data47 === "open" ||
        data47 === "fixed" ||
        data47 === "dismissed"
      )) {
        const err120 = {
          instancePath: instancePath + "/status",
          schemaPath: "#/properties/status/enum",
          keyword: "enum",
          params: { allowedValues: schema38.properties.status.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err120];
        } else {
          vErrors.push(err120);
        }
        errors++;
      }
    }
    if (data.resolution !== undefined) {
      let data48 = data.resolution;
      if (data48 && typeof data48 == "object" && !Array.isArray(data48)) {
        for (const key7 in data48) {
          if (!(key7 === "fixed_in" || key7 === "note")) {
            const err121 = {
              instancePath: instancePath + "/resolution",
              schemaPath: "#/properties/resolution/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key7 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err121];
            } else {
              vErrors.push(err121);
            }
            errors++;
          }
        }
        if (data48.fixed_in !== undefined) {
          let data49 = data48.fixed_in;
          if (typeof data49 === "string") {
            if (func2(data49) < 1) {
              const err122 = {
                instancePath: instancePath + "/resolution/fixed_in",
                schemaPath:
                  "#/properties/resolution/properties/fixed_in/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err122];
              } else {
                vErrors.push(err122);
              }
              errors++;
            }
          } else {
            const err123 = {
              instancePath: instancePath + "/resolution/fixed_in",
              schemaPath: "#/properties/resolution/properties/fixed_in/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err123];
            } else {
              vErrors.push(err123);
            }
            errors++;
          }
        }
        if (data48.note !== undefined) {
          let data50 = data48.note;
          if (typeof data50 === "string") {
            if (func2(data50) < 1) {
              const err124 = {
                instancePath: instancePath + "/resolution/note",
                schemaPath: "#/properties/resolution/properties/note/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err124];
              } else {
                vErrors.push(err124);
              }
              errors++;
            }
          } else {
            const err125 = {
              instancePath: instancePath + "/resolution/note",
              schemaPath: "#/properties/resolution/properties/note/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err125];
            } else {
              vErrors.push(err125);
            }
            errors++;
          }
        }
      } else {
        const err126 = {
          instancePath: instancePath + "/resolution",
          schemaPath: "#/properties/resolution/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err126];
        } else {
          vErrors.push(err126);
        }
        errors++;
      }
    }
    if (data.verification !== undefined) {
      let data51 = data.verification;
      if (data51 && typeof data51 == "object" && !Array.isArray(data51)) {
        if (data51.voters === undefined) {
          const err127 = {
            instancePath: instancePath + "/verification",
            schemaPath: "#/properties/verification/required",
            keyword: "required",
            params: { missingProperty: "voters" },
            message: "must have required property '" + "voters" + "'",
          };
          if (vErrors === null) {
            vErrors = [err127];
          } else {
            vErrors.push(err127);
          }
          errors++;
        }
        if (data51.agreeing === undefined) {
          const err128 = {
            instancePath: instancePath + "/verification",
            schemaPath: "#/properties/verification/required",
            keyword: "required",
            params: { missingProperty: "agreeing" },
            message: "must have required property '" + "agreeing" + "'",
          };
          if (vErrors === null) {
            vErrors = [err128];
          } else {
            vErrors.push(err128);
          }
          errors++;
        }
        if (data51.blind_match === undefined) {
          const err129 = {
            instancePath: instancePath + "/verification",
            schemaPath: "#/properties/verification/required",
            keyword: "required",
            params: { missingProperty: "blind_match" },
            message: "must have required property '" + "blind_match" + "'",
          };
          if (vErrors === null) {
            vErrors = [err129];
          } else {
            vErrors.push(err129);
          }
          errors++;
        }
        if (data51.split === undefined) {
          const err130 = {
            instancePath: instancePath + "/verification",
            schemaPath: "#/properties/verification/required",
            keyword: "required",
            params: { missingProperty: "split" },
            message: "must have required property '" + "split" + "'",
          };
          if (vErrors === null) {
            vErrors = [err130];
          } else {
            vErrors.push(err130);
          }
          errors++;
        }
        for (const key8 in data51) {
          if (!(
            key8 === "voters" ||
            key8 === "agreeing" ||
            key8 === "blind_match" ||
            key8 === "split"
          )) {
            const err131 = {
              instancePath: instancePath + "/verification",
              schemaPath: "#/properties/verification/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key8 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err131];
            } else {
              vErrors.push(err131);
            }
            errors++;
          }
        }
        if (data51.voters !== undefined) {
          let data52 = data51.voters;
          if (!(typeof data52 == "number" && !(data52 % 1) && !isNaN(data52))) {
            const err132 = {
              instancePath: instancePath + "/verification/voters",
              schemaPath: "#/properties/verification/properties/voters/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err132];
            } else {
              vErrors.push(err132);
            }
            errors++;
          }
          if (typeof data52 == "number") {
            if (data52 < 1 || isNaN(data52)) {
              const err133 = {
                instancePath: instancePath + "/verification/voters",
                schemaPath:
                  "#/properties/verification/properties/voters/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err133];
              } else {
                vErrors.push(err133);
              }
              errors++;
            }
          }
        }
        if (data51.agreeing !== undefined) {
          let data53 = data51.agreeing;
          if (!(typeof data53 == "number" && !(data53 % 1) && !isNaN(data53))) {
            const err134 = {
              instancePath: instancePath + "/verification/agreeing",
              schemaPath: "#/properties/verification/properties/agreeing/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err134];
            } else {
              vErrors.push(err134);
            }
            errors++;
          }
          if (typeof data53 == "number") {
            if (data53 < 0 || isNaN(data53)) {
              const err135 = {
                instancePath: instancePath + "/verification/agreeing",
                schemaPath:
                  "#/properties/verification/properties/agreeing/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 0 },
                message: "must be >= 0",
              };
              if (vErrors === null) {
                vErrors = [err135];
              } else {
                vErrors.push(err135);
              }
              errors++;
            }
          }
        }
        if (data51.blind_match !== undefined) {
          let data54 = data51.blind_match;
          if (Array.isArray(data54)) {
            const len3 = data54.length;
            for (let i3 = 0; i3 < len3; i3++) {
              let data55 = data54[i3];
              if (!(
                data55 === "same" ||
                data55 === "related" ||
                data55 === "none"
              )) {
                const err136 = {
                  instancePath:
                    instancePath + "/verification/blind_match/" + i3,
                  schemaPath:
                    "#/properties/verification/properties/blind_match/items/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema38.properties.verification.properties.blind_match
                        .items.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err136];
                } else {
                  vErrors.push(err136);
                }
                errors++;
              }
            }
          } else {
            const err137 = {
              instancePath: instancePath + "/verification/blind_match",
              schemaPath:
                "#/properties/verification/properties/blind_match/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err137];
            } else {
              vErrors.push(err137);
            }
            errors++;
          }
        }
        if (data51.split !== undefined) {
          if (typeof data51.split !== "boolean") {
            const err138 = {
              instancePath: instancePath + "/verification/split",
              schemaPath: "#/properties/verification/properties/split/type",
              keyword: "type",
              params: { type: "boolean" },
              message: "must be boolean",
            };
            if (vErrors === null) {
              vErrors = [err138];
            } else {
              vErrors.push(err138);
            }
            errors++;
          }
        }
      } else {
        const err139 = {
          instancePath: instancePath + "/verification",
          schemaPath: "#/properties/verification/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err139];
        } else {
          vErrors.push(err139);
        }
        errors++;
      }
    }
  } else {
    const err140 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err140];
    } else {
      vErrors.push(err140);
    }
    errors++;
  }
  validate25.errors = vErrors;
  return errors === 0;
}
validate25.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const hypothesis = validate26;
const schema39 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Rio hypothesis v1",
  type: "object",
  properties: {
    id: { type: "string" },
    rule_id: {
      type: "string",
      minLength: 1,
      maxLength: 150,
      pattern: "^[a-zA-Z0-9_/-]+$",
    },
    category: { enum: ["defect", "risk", "security", "style", "diagnostic"] },
    severity: { enum: ["error", "warning", "info"] },
    location: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        line_start: { type: "integer", minimum: 1 },
        line_end: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        symbol_path: { type: "string" },
        occurrence_state: {
          enum: ["new", "pre-existing", "fixed", "unclassified"],
        },
      },
      required: ["path", "line_start", "line_end", "symbol_path"],
      additionalProperties: false,
    },
    message: { type: "string", maxLength: 16000 },
    trigger: { type: "string", maxLength: 16000 },
    impact: { type: "string", maxLength: 16000 },
    suggested_fix: { type: "string", maxLength: 16000 },
    state: {
      enum: ["new", "worsened", "pre-existing", "fixed", "unclassified"],
    },
    source: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
      additionalProperties: false,
    },
    guidance: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "integer", minimum: 1 },
      },
      required: ["path", "line"],
      additionalProperties: false,
    },
    evidence: { type: "array", items: { type: "string" }, maxItems: 100 },
  },
  required: [
    "rule_id",
    "category",
    "severity",
    "location",
    "message",
    "trigger",
  ],
  additionalProperties: false,
};
const pattern31 = new RegExp("^[a-zA-Z0-9_/-]+$", "u");
function validate26(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate26.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.rule_id === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "rule_id" },
        message: "must have required property '" + "rule_id" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.category === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "category" },
        message: "must have required property '" + "category" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.severity === undefined) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "severity" },
        message: "must have required property '" + "severity" + "'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.location === undefined) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "location" },
        message: "must have required property '" + "location" + "'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.message === undefined) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "message" },
        message: "must have required property '" + "message" + "'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.trigger === undefined) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "trigger" },
        message: "must have required property '" + "trigger" + "'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func1.call(schema39.properties, key0)) {
        const err6 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.id !== undefined) {
      if (typeof data.id !== "string") {
        const err7 = {
          instancePath: instancePath + "/id",
          schemaPath: "#/properties/id/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.rule_id !== undefined) {
      let data1 = data.rule_id;
      if (typeof data1 === "string") {
        if (func2(data1) > 150) {
          const err8 = {
            instancePath: instancePath + "/rule_id",
            schemaPath: "#/properties/rule_id/maxLength",
            keyword: "maxLength",
            params: { limit: 150 },
            message: "must NOT have more than 150 characters",
          };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
        if (func2(data1) < 1) {
          const err9 = {
            instancePath: instancePath + "/rule_id",
            schemaPath: "#/properties/rule_id/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
        if (!pattern31.test(data1)) {
          const err10 = {
            instancePath: instancePath + "/rule_id",
            schemaPath: "#/properties/rule_id/pattern",
            keyword: "pattern",
            params: { pattern: "^[a-zA-Z0-9_/-]+$" },
            message: 'must match pattern "' + "^[a-zA-Z0-9_/-]+$" + '"',
          };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      } else {
        const err11 = {
          instancePath: instancePath + "/rule_id",
          schemaPath: "#/properties/rule_id/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.category !== undefined) {
      let data2 = data.category;
      if (!(
        data2 === "defect" ||
        data2 === "risk" ||
        data2 === "security" ||
        data2 === "style" ||
        data2 === "diagnostic"
      )) {
        const err12 = {
          instancePath: instancePath + "/category",
          schemaPath: "#/properties/category/enum",
          keyword: "enum",
          params: { allowedValues: schema39.properties.category.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.severity !== undefined) {
      let data3 = data.severity;
      if (!(data3 === "error" || data3 === "warning" || data3 === "info")) {
        const err13 = {
          instancePath: instancePath + "/severity",
          schemaPath: "#/properties/severity/enum",
          keyword: "enum",
          params: { allowedValues: schema39.properties.severity.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.location !== undefined) {
      let data4 = data.location;
      if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
        if (data4.path === undefined) {
          const err14 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "path" },
            message: "must have required property '" + "path" + "'",
          };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
        if (data4.line_start === undefined) {
          const err15 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "line_start" },
            message: "must have required property '" + "line_start" + "'",
          };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
        if (data4.line_end === undefined) {
          const err16 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "line_end" },
            message: "must have required property '" + "line_end" + "'",
          };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
        if (data4.symbol_path === undefined) {
          const err17 = {
            instancePath: instancePath + "/location",
            schemaPath: "#/properties/location/required",
            keyword: "required",
            params: { missingProperty: "symbol_path" },
            message: "must have required property '" + "symbol_path" + "'",
          };
          if (vErrors === null) {
            vErrors = [err17];
          } else {
            vErrors.push(err17);
          }
          errors++;
        }
        for (const key1 in data4) {
          if (!(
            key1 === "path" ||
            key1 === "line_start" ||
            key1 === "line_end" ||
            key1 === "column" ||
            key1 === "symbol_path" ||
            key1 === "occurrence_state"
          )) {
            const err18 = {
              instancePath: instancePath + "/location",
              schemaPath: "#/properties/location/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key1 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
        if (data4.path !== undefined) {
          let data5 = data4.path;
          if (typeof data5 === "string") {
            if (func2(data5) < 1) {
              const err19 = {
                instancePath: instancePath + "/location/path",
                schemaPath: "#/properties/location/properties/path/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err19];
              } else {
                vErrors.push(err19);
              }
              errors++;
            }
          } else {
            const err20 = {
              instancePath: instancePath + "/location/path",
              schemaPath: "#/properties/location/properties/path/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err20];
            } else {
              vErrors.push(err20);
            }
            errors++;
          }
        }
        if (data4.line_start !== undefined) {
          let data6 = data4.line_start;
          if (!(typeof data6 == "number" && !(data6 % 1) && !isNaN(data6))) {
            const err21 = {
              instancePath: instancePath + "/location/line_start",
              schemaPath: "#/properties/location/properties/line_start/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err21];
            } else {
              vErrors.push(err21);
            }
            errors++;
          }
          if (typeof data6 == "number") {
            if (data6 < 1 || isNaN(data6)) {
              const err22 = {
                instancePath: instancePath + "/location/line_start",
                schemaPath:
                  "#/properties/location/properties/line_start/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err22];
              } else {
                vErrors.push(err22);
              }
              errors++;
            }
          }
        }
        if (data4.line_end !== undefined) {
          let data7 = data4.line_end;
          if (!(typeof data7 == "number" && !(data7 % 1) && !isNaN(data7))) {
            const err23 = {
              instancePath: instancePath + "/location/line_end",
              schemaPath: "#/properties/location/properties/line_end/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err23];
            } else {
              vErrors.push(err23);
            }
            errors++;
          }
          if (typeof data7 == "number") {
            if (data7 < 1 || isNaN(data7)) {
              const err24 = {
                instancePath: instancePath + "/location/line_end",
                schemaPath: "#/properties/location/properties/line_end/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err24];
              } else {
                vErrors.push(err24);
              }
              errors++;
            }
          }
        }
        if (data4.column !== undefined) {
          let data8 = data4.column;
          if (!(typeof data8 == "number" && !(data8 % 1) && !isNaN(data8))) {
            const err25 = {
              instancePath: instancePath + "/location/column",
              schemaPath: "#/properties/location/properties/column/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err25];
            } else {
              vErrors.push(err25);
            }
            errors++;
          }
          if (typeof data8 == "number") {
            if (data8 < 1 || isNaN(data8)) {
              const err26 = {
                instancePath: instancePath + "/location/column",
                schemaPath: "#/properties/location/properties/column/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err26];
              } else {
                vErrors.push(err26);
              }
              errors++;
            }
          }
        }
        if (data4.symbol_path !== undefined) {
          if (typeof data4.symbol_path !== "string") {
            const err27 = {
              instancePath: instancePath + "/location/symbol_path",
              schemaPath: "#/properties/location/properties/symbol_path/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err27];
            } else {
              vErrors.push(err27);
            }
            errors++;
          }
        }
        if (data4.occurrence_state !== undefined) {
          let data10 = data4.occurrence_state;
          if (!(
            data10 === "new" ||
            data10 === "pre-existing" ||
            data10 === "fixed" ||
            data10 === "unclassified"
          )) {
            const err28 = {
              instancePath: instancePath + "/location/occurrence_state",
              schemaPath:
                "#/properties/location/properties/occurrence_state/enum",
              keyword: "enum",
              params: {
                allowedValues:
                  schema39.properties.location.properties.occurrence_state.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err28];
            } else {
              vErrors.push(err28);
            }
            errors++;
          }
        }
      } else {
        const err29 = {
          instancePath: instancePath + "/location",
          schemaPath: "#/properties/location/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err29];
        } else {
          vErrors.push(err29);
        }
        errors++;
      }
    }
    if (data.message !== undefined) {
      let data11 = data.message;
      if (typeof data11 === "string") {
        if (func2(data11) > 16000) {
          const err30 = {
            instancePath: instancePath + "/message",
            schemaPath: "#/properties/message/maxLength",
            keyword: "maxLength",
            params: { limit: 16000 },
            message: "must NOT have more than 16000 characters",
          };
          if (vErrors === null) {
            vErrors = [err30];
          } else {
            vErrors.push(err30);
          }
          errors++;
        }
      } else {
        const err31 = {
          instancePath: instancePath + "/message",
          schemaPath: "#/properties/message/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err31];
        } else {
          vErrors.push(err31);
        }
        errors++;
      }
    }
    if (data.trigger !== undefined) {
      let data12 = data.trigger;
      if (typeof data12 === "string") {
        if (func2(data12) > 16000) {
          const err32 = {
            instancePath: instancePath + "/trigger",
            schemaPath: "#/properties/trigger/maxLength",
            keyword: "maxLength",
            params: { limit: 16000 },
            message: "must NOT have more than 16000 characters",
          };
          if (vErrors === null) {
            vErrors = [err32];
          } else {
            vErrors.push(err32);
          }
          errors++;
        }
      } else {
        const err33 = {
          instancePath: instancePath + "/trigger",
          schemaPath: "#/properties/trigger/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err33];
        } else {
          vErrors.push(err33);
        }
        errors++;
      }
    }
    if (data.impact !== undefined) {
      let data13 = data.impact;
      if (typeof data13 === "string") {
        if (func2(data13) > 16000) {
          const err34 = {
            instancePath: instancePath + "/impact",
            schemaPath: "#/properties/impact/maxLength",
            keyword: "maxLength",
            params: { limit: 16000 },
            message: "must NOT have more than 16000 characters",
          };
          if (vErrors === null) {
            vErrors = [err34];
          } else {
            vErrors.push(err34);
          }
          errors++;
        }
      } else {
        const err35 = {
          instancePath: instancePath + "/impact",
          schemaPath: "#/properties/impact/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err35];
        } else {
          vErrors.push(err35);
        }
        errors++;
      }
    }
    if (data.suggested_fix !== undefined) {
      let data14 = data.suggested_fix;
      if (typeof data14 === "string") {
        if (func2(data14) > 16000) {
          const err36 = {
            instancePath: instancePath + "/suggested_fix",
            schemaPath: "#/properties/suggested_fix/maxLength",
            keyword: "maxLength",
            params: { limit: 16000 },
            message: "must NOT have more than 16000 characters",
          };
          if (vErrors === null) {
            vErrors = [err36];
          } else {
            vErrors.push(err36);
          }
          errors++;
        }
      } else {
        const err37 = {
          instancePath: instancePath + "/suggested_fix",
          schemaPath: "#/properties/suggested_fix/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err37];
        } else {
          vErrors.push(err37);
        }
        errors++;
      }
    }
    if (data.state !== undefined) {
      let data15 = data.state;
      if (!(
        data15 === "new" ||
        data15 === "worsened" ||
        data15 === "pre-existing" ||
        data15 === "fixed" ||
        data15 === "unclassified"
      )) {
        const err38 = {
          instancePath: instancePath + "/state",
          schemaPath: "#/properties/state/enum",
          keyword: "enum",
          params: { allowedValues: schema39.properties.state.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err38];
        } else {
          vErrors.push(err38);
        }
        errors++;
      }
    }
    if (data.source !== undefined) {
      let data16 = data.source;
      if (data16 && typeof data16 == "object" && !Array.isArray(data16)) {
        if (data16.agent === undefined) {
          const err39 = {
            instancePath: instancePath + "/source",
            schemaPath: "#/properties/source/required",
            keyword: "required",
            params: { missingProperty: "agent" },
            message: "must have required property '" + "agent" + "'",
          };
          if (vErrors === null) {
            vErrors = [err39];
          } else {
            vErrors.push(err39);
          }
          errors++;
        }
        for (const key2 in data16) {
          if (!(key2 === "agent")) {
            const err40 = {
              instancePath: instancePath + "/source",
              schemaPath: "#/properties/source/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key2 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err40];
            } else {
              vErrors.push(err40);
            }
            errors++;
          }
        }
        if (data16.agent !== undefined) {
          if (typeof data16.agent !== "string") {
            const err41 = {
              instancePath: instancePath + "/source/agent",
              schemaPath: "#/properties/source/properties/agent/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err41];
            } else {
              vErrors.push(err41);
            }
            errors++;
          }
        }
      } else {
        const err42 = {
          instancePath: instancePath + "/source",
          schemaPath: "#/properties/source/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err42];
        } else {
          vErrors.push(err42);
        }
        errors++;
      }
    }
    if (data.guidance !== undefined) {
      let data18 = data.guidance;
      if (data18 && typeof data18 == "object" && !Array.isArray(data18)) {
        if (data18.path === undefined) {
          const err43 = {
            instancePath: instancePath + "/guidance",
            schemaPath: "#/properties/guidance/required",
            keyword: "required",
            params: { missingProperty: "path" },
            message: "must have required property '" + "path" + "'",
          };
          if (vErrors === null) {
            vErrors = [err43];
          } else {
            vErrors.push(err43);
          }
          errors++;
        }
        if (data18.line === undefined) {
          const err44 = {
            instancePath: instancePath + "/guidance",
            schemaPath: "#/properties/guidance/required",
            keyword: "required",
            params: { missingProperty: "line" },
            message: "must have required property '" + "line" + "'",
          };
          if (vErrors === null) {
            vErrors = [err44];
          } else {
            vErrors.push(err44);
          }
          errors++;
        }
        for (const key3 in data18) {
          if (!(key3 === "path" || key3 === "line")) {
            const err45 = {
              instancePath: instancePath + "/guidance",
              schemaPath: "#/properties/guidance/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key3 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err45];
            } else {
              vErrors.push(err45);
            }
            errors++;
          }
        }
        if (data18.path !== undefined) {
          if (typeof data18.path !== "string") {
            const err46 = {
              instancePath: instancePath + "/guidance/path",
              schemaPath: "#/properties/guidance/properties/path/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err46];
            } else {
              vErrors.push(err46);
            }
            errors++;
          }
        }
        if (data18.line !== undefined) {
          let data20 = data18.line;
          if (!(typeof data20 == "number" && !(data20 % 1) && !isNaN(data20))) {
            const err47 = {
              instancePath: instancePath + "/guidance/line",
              schemaPath: "#/properties/guidance/properties/line/type",
              keyword: "type",
              params: { type: "integer" },
              message: "must be integer",
            };
            if (vErrors === null) {
              vErrors = [err47];
            } else {
              vErrors.push(err47);
            }
            errors++;
          }
          if (typeof data20 == "number") {
            if (data20 < 1 || isNaN(data20)) {
              const err48 = {
                instancePath: instancePath + "/guidance/line",
                schemaPath: "#/properties/guidance/properties/line/minimum",
                keyword: "minimum",
                params: { comparison: ">=", limit: 1 },
                message: "must be >= 1",
              };
              if (vErrors === null) {
                vErrors = [err48];
              } else {
                vErrors.push(err48);
              }
              errors++;
            }
          }
        }
      } else {
        const err49 = {
          instancePath: instancePath + "/guidance",
          schemaPath: "#/properties/guidance/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err49];
        } else {
          vErrors.push(err49);
        }
        errors++;
      }
    }
    if (data.evidence !== undefined) {
      let data21 = data.evidence;
      if (Array.isArray(data21)) {
        if (data21.length > 100) {
          const err50 = {
            instancePath: instancePath + "/evidence",
            schemaPath: "#/properties/evidence/maxItems",
            keyword: "maxItems",
            params: { limit: 100 },
            message: "must NOT have more than 100 items",
          };
          if (vErrors === null) {
            vErrors = [err50];
          } else {
            vErrors.push(err50);
          }
          errors++;
        }
        const len0 = data21.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (typeof data21[i0] !== "string") {
            const err51 = {
              instancePath: instancePath + "/evidence/" + i0,
              schemaPath: "#/properties/evidence/items/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err51];
            } else {
              vErrors.push(err51);
            }
            errors++;
          }
        }
      } else {
        const err52 = {
          instancePath: instancePath + "/evidence",
          schemaPath: "#/properties/evidence/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err52];
        } else {
          vErrors.push(err52);
        }
        errors++;
      }
    }
  } else {
    const err53 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err53];
    } else {
      vErrors.push(err53);
    }
    errors++;
  }
  validate26.errors = vErrors;
  return errors === 0;
}
validate26.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const answer = validate27;
const schema40 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Rio vote answer v1",
  type: "object",
  properties: {
    evidence_level: {
      enum: ["refuted", "plausible", "static_proven", "reproduced"],
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { enum: ["execution", "code"] },
          version: { enum: ["base", "head"] },
          job_id: { type: "string" },
          path: { type: "string" },
          node_ids: { type: "array", items: { type: "string" }, maxItems: 100 },
          demonstrates: { enum: ["regression", "protection"] },
        },
        required: ["kind", "version", "demonstrates"],
        additionalProperties: false,
      },
      maxItems: 100,
    },
    category: { enum: ["defect", "risk", "security", "style", "diagnostic"] },
    reclassification_reason: { type: "string", minLength: 1, maxLength: 16000 },
  },
  required: ["evidence_level", "evidence"],
  additionalProperties: false,
};
function validate27(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate27.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.evidence_level === undefined) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "evidence_level" },
        message: "must have required property '" + "evidence_level" + "'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.evidence === undefined) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "evidence" },
        message: "must have required property '" + "evidence" + "'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(
        key0 === "evidence_level" ||
        key0 === "evidence" ||
        key0 === "category" ||
        key0 === "reclassification_reason"
      )) {
        const err2 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.evidence_level !== undefined) {
      let data0 = data.evidence_level;
      if (!(
        data0 === "refuted" ||
        data0 === "plausible" ||
        data0 === "static_proven" ||
        data0 === "reproduced"
      )) {
        const err3 = {
          instancePath: instancePath + "/evidence_level",
          schemaPath: "#/properties/evidence_level/enum",
          keyword: "enum",
          params: { allowedValues: schema40.properties.evidence_level.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.evidence !== undefined) {
      let data1 = data.evidence;
      if (Array.isArray(data1)) {
        if (data1.length > 100) {
          const err4 = {
            instancePath: instancePath + "/evidence",
            schemaPath: "#/properties/evidence/maxItems",
            keyword: "maxItems",
            params: { limit: 100 },
            message: "must NOT have more than 100 items",
          };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
        const len0 = data1.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data2 = data1[i0];
          if (data2 && typeof data2 == "object" && !Array.isArray(data2)) {
            if (data2.kind === undefined) {
              const err5 = {
                instancePath: instancePath + "/evidence/" + i0,
                schemaPath: "#/properties/evidence/items/required",
                keyword: "required",
                params: { missingProperty: "kind" },
                message: "must have required property '" + "kind" + "'",
              };
              if (vErrors === null) {
                vErrors = [err5];
              } else {
                vErrors.push(err5);
              }
              errors++;
            }
            if (data2.version === undefined) {
              const err6 = {
                instancePath: instancePath + "/evidence/" + i0,
                schemaPath: "#/properties/evidence/items/required",
                keyword: "required",
                params: { missingProperty: "version" },
                message: "must have required property '" + "version" + "'",
              };
              if (vErrors === null) {
                vErrors = [err6];
              } else {
                vErrors.push(err6);
              }
              errors++;
            }
            if (data2.demonstrates === undefined) {
              const err7 = {
                instancePath: instancePath + "/evidence/" + i0,
                schemaPath: "#/properties/evidence/items/required",
                keyword: "required",
                params: { missingProperty: "demonstrates" },
                message: "must have required property '" + "demonstrates" + "'",
              };
              if (vErrors === null) {
                vErrors = [err7];
              } else {
                vErrors.push(err7);
              }
              errors++;
            }
            for (const key1 in data2) {
              if (!(
                key1 === "kind" ||
                key1 === "version" ||
                key1 === "job_id" ||
                key1 === "path" ||
                key1 === "node_ids" ||
                key1 === "demonstrates"
              )) {
                const err8 = {
                  instancePath: instancePath + "/evidence/" + i0,
                  schemaPath:
                    "#/properties/evidence/items/additionalProperties",
                  keyword: "additionalProperties",
                  params: { additionalProperty: key1 },
                  message: "must NOT have additional properties",
                };
                if (vErrors === null) {
                  vErrors = [err8];
                } else {
                  vErrors.push(err8);
                }
                errors++;
              }
            }
            if (data2.kind !== undefined) {
              let data3 = data2.kind;
              if (!(data3 === "execution" || data3 === "code")) {
                const err9 = {
                  instancePath: instancePath + "/evidence/" + i0 + "/kind",
                  schemaPath:
                    "#/properties/evidence/items/properties/kind/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema40.properties.evidence.items.properties.kind.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err9];
                } else {
                  vErrors.push(err9);
                }
                errors++;
              }
            }
            if (data2.version !== undefined) {
              let data4 = data2.version;
              if (!(data4 === "base" || data4 === "head")) {
                const err10 = {
                  instancePath: instancePath + "/evidence/" + i0 + "/version",
                  schemaPath:
                    "#/properties/evidence/items/properties/version/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema40.properties.evidence.items.properties.version
                        .enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err10];
                } else {
                  vErrors.push(err10);
                }
                errors++;
              }
            }
            if (data2.job_id !== undefined) {
              if (typeof data2.job_id !== "string") {
                const err11 = {
                  instancePath: instancePath + "/evidence/" + i0 + "/job_id",
                  schemaPath:
                    "#/properties/evidence/items/properties/job_id/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err11];
                } else {
                  vErrors.push(err11);
                }
                errors++;
              }
            }
            if (data2.path !== undefined) {
              if (typeof data2.path !== "string") {
                const err12 = {
                  instancePath: instancePath + "/evidence/" + i0 + "/path",
                  schemaPath:
                    "#/properties/evidence/items/properties/path/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err12];
                } else {
                  vErrors.push(err12);
                }
                errors++;
              }
            }
            if (data2.node_ids !== undefined) {
              let data7 = data2.node_ids;
              if (Array.isArray(data7)) {
                if (data7.length > 100) {
                  const err13 = {
                    instancePath:
                      instancePath + "/evidence/" + i0 + "/node_ids",
                    schemaPath:
                      "#/properties/evidence/items/properties/node_ids/maxItems",
                    keyword: "maxItems",
                    params: { limit: 100 },
                    message: "must NOT have more than 100 items",
                  };
                  if (vErrors === null) {
                    vErrors = [err13];
                  } else {
                    vErrors.push(err13);
                  }
                  errors++;
                }
                const len1 = data7.length;
                for (let i1 = 0; i1 < len1; i1++) {
                  if (typeof data7[i1] !== "string") {
                    const err14 = {
                      instancePath:
                        instancePath + "/evidence/" + i0 + "/node_ids/" + i1,
                      schemaPath:
                        "#/properties/evidence/items/properties/node_ids/items/type",
                      keyword: "type",
                      params: { type: "string" },
                      message: "must be string",
                    };
                    if (vErrors === null) {
                      vErrors = [err14];
                    } else {
                      vErrors.push(err14);
                    }
                    errors++;
                  }
                }
              } else {
                const err15 = {
                  instancePath: instancePath + "/evidence/" + i0 + "/node_ids",
                  schemaPath:
                    "#/properties/evidence/items/properties/node_ids/type",
                  keyword: "type",
                  params: { type: "array" },
                  message: "must be array",
                };
                if (vErrors === null) {
                  vErrors = [err15];
                } else {
                  vErrors.push(err15);
                }
                errors++;
              }
            }
            if (data2.demonstrates !== undefined) {
              let data9 = data2.demonstrates;
              if (!(data9 === "regression" || data9 === "protection")) {
                const err16 = {
                  instancePath:
                    instancePath + "/evidence/" + i0 + "/demonstrates",
                  schemaPath:
                    "#/properties/evidence/items/properties/demonstrates/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema40.properties.evidence.items.properties.demonstrates
                        .enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err16];
                } else {
                  vErrors.push(err16);
                }
                errors++;
              }
            }
          } else {
            const err17 = {
              instancePath: instancePath + "/evidence/" + i0,
              schemaPath: "#/properties/evidence/items/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err17];
            } else {
              vErrors.push(err17);
            }
            errors++;
          }
        }
      } else {
        const err18 = {
          instancePath: instancePath + "/evidence",
          schemaPath: "#/properties/evidence/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
    }
    if (data.category !== undefined) {
      let data10 = data.category;
      if (!(
        data10 === "defect" ||
        data10 === "risk" ||
        data10 === "security" ||
        data10 === "style" ||
        data10 === "diagnostic"
      )) {
        const err19 = {
          instancePath: instancePath + "/category",
          schemaPath: "#/properties/category/enum",
          keyword: "enum",
          params: { allowedValues: schema40.properties.category.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
    }
    if (data.reclassification_reason !== undefined) {
      let data11 = data.reclassification_reason;
      if (typeof data11 === "string") {
        if (func2(data11) > 16000) {
          const err20 = {
            instancePath: instancePath + "/reclassification_reason",
            schemaPath: "#/properties/reclassification_reason/maxLength",
            keyword: "maxLength",
            params: { limit: 16000 },
            message: "must NOT have more than 16000 characters",
          };
          if (vErrors === null) {
            vErrors = [err20];
          } else {
            vErrors.push(err20);
          }
          errors++;
        }
        if (func2(data11) < 1) {
          const err21 = {
            instancePath: instancePath + "/reclassification_reason",
            schemaPath: "#/properties/reclassification_reason/minLength",
            keyword: "minLength",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 characters",
          };
          if (vErrors === null) {
            vErrors = [err21];
          } else {
            vErrors.push(err21);
          }
          errors++;
        }
      } else {
        const err22 = {
          instancePath: instancePath + "/reclassification_reason",
          schemaPath: "#/properties/reclassification_reason/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err22];
        } else {
          vErrors.push(err22);
        }
        errors++;
      }
    }
  } else {
    const err23 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err23];
    } else {
      vErrors.push(err23);
    }
    errors++;
  }
  validate27.errors = vErrors;
  return errors === 0;
}
validate27.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const module0 = validate28;
const schema41 = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
function validate28(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate28.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      const err0 = {
        instancePath,
        schemaPath: "#/additionalProperties",
        keyword: "additionalProperties",
        params: { additionalProperty: key0 },
        message: "must NOT have additional properties",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate28.errors = vErrors;
  return errors === 0;
}
validate28.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const module1 = validate29;
const schema42 = {
  type: "object",
  additionalProperties: false,
  properties: {
    typecheck: { type: "boolean", default: true },
    lint: { type: "boolean", default: true },
    secrets: { type: "boolean", default: true },
    coverage: { type: "boolean", default: true },
    dependencies: { type: "boolean", default: true },
    baseline: { type: "boolean", default: true },
    trust_installed_dependencies: { type: "boolean", default: false },
  },
};
function validate29(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate29.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(
        key0 === "typecheck" ||
        key0 === "lint" ||
        key0 === "secrets" ||
        key0 === "coverage" ||
        key0 === "dependencies" ||
        key0 === "baseline" ||
        key0 === "trust_installed_dependencies"
      )) {
        const err0 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.typecheck !== undefined) {
      if (typeof data.typecheck !== "boolean") {
        const err1 = {
          instancePath: instancePath + "/typecheck",
          schemaPath: "#/properties/typecheck/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.lint !== undefined) {
      if (typeof data.lint !== "boolean") {
        const err2 = {
          instancePath: instancePath + "/lint",
          schemaPath: "#/properties/lint/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.secrets !== undefined) {
      if (typeof data.secrets !== "boolean") {
        const err3 = {
          instancePath: instancePath + "/secrets",
          schemaPath: "#/properties/secrets/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.coverage !== undefined) {
      if (typeof data.coverage !== "boolean") {
        const err4 = {
          instancePath: instancePath + "/coverage",
          schemaPath: "#/properties/coverage/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.dependencies !== undefined) {
      if (typeof data.dependencies !== "boolean") {
        const err5 = {
          instancePath: instancePath + "/dependencies",
          schemaPath: "#/properties/dependencies/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.baseline !== undefined) {
      if (typeof data.baseline !== "boolean") {
        const err6 = {
          instancePath: instancePath + "/baseline",
          schemaPath: "#/properties/baseline/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.trust_installed_dependencies !== undefined) {
      if (typeof data.trust_installed_dependencies !== "boolean") {
        const err7 = {
          instancePath: instancePath + "/trust_installed_dependencies",
          schemaPath: "#/properties/trust_installed_dependencies/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
  } else {
    const err8 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err8];
    } else {
      vErrors.push(err8);
    }
    errors++;
  }
  validate29.errors = vErrors;
  return errors === 0;
}
validate29.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const module2 = validate30;
const schema43 = {
  type: "object",
  additionalProperties: false,
  properties: {
    hops: { type: "integer", minimum: 0, default: 2 },
    max_nodes: { type: "integer", minimum: 1, default: 2000 },
  },
};
function validate30(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate30.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "hops" || key0 === "max_nodes")) {
        const err0 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.hops !== undefined) {
      let data0 = data.hops;
      if (!(typeof data0 == "number" && !(data0 % 1) && !isNaN(data0))) {
        const err1 = {
          instancePath: instancePath + "/hops",
          schemaPath: "#/properties/hops/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (typeof data0 == "number") {
        if (data0 < 0 || isNaN(data0)) {
          const err2 = {
            instancePath: instancePath + "/hops",
            schemaPath: "#/properties/hops/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 0 },
            message: "must be >= 0",
          };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
      }
    }
    if (data.max_nodes !== undefined) {
      let data1 = data.max_nodes;
      if (!(typeof data1 == "number" && !(data1 % 1) && !isNaN(data1))) {
        const err3 = {
          instancePath: instancePath + "/max_nodes",
          schemaPath: "#/properties/max_nodes/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
      if (typeof data1 == "number") {
        if (data1 < 1 || isNaN(data1)) {
          const err4 = {
            instancePath: instancePath + "/max_nodes",
            schemaPath: "#/properties/max_nodes/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 1 },
            message: "must be >= 1",
          };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
      }
    }
  } else {
    const err5 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err5];
    } else {
      vErrors.push(err5);
    }
    errors++;
  }
  validate30.errors = vErrors;
  return errors === 0;
}
validate30.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const module3 = validate31;
const schema44 = {
  type: "object",
  additionalProperties: false,
  properties: {
    exclude: { type: "array", items: { type: "string" }, default: [] },
  },
};
function validate31(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate31.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "exclude")) {
        const err0 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.exclude !== undefined) {
      let data0 = data.exclude;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (typeof data0[i0] !== "string") {
            const err1 = {
              instancePath: instancePath + "/exclude/" + i0,
              schemaPath: "#/properties/exclude/items/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err1];
            } else {
              vErrors.push(err1);
            }
            errors++;
          }
        }
      } else {
        const err2 = {
          instancePath: instancePath + "/exclude",
          schemaPath: "#/properties/exclude/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
  } else {
    const err3 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate31.errors = vErrors;
  return errors === 0;
}
validate31.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const module4 = validate32;
const schema45 = {
  type: "object",
  additionalProperties: false,
  properties: {
    class_threshold: {
      type: "integer",
      minimum: 1,
      default: 3,
      description:
        "Agent findings sharing rule and trigger across more symbols than this merge into one class-level finding",
    },
  },
};
function validate32(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate32.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "class_threshold")) {
        const err0 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.class_threshold !== undefined) {
      let data0 = data.class_threshold;
      if (!(typeof data0 == "number" && !(data0 % 1) && !isNaN(data0))) {
        const err1 = {
          instancePath: instancePath + "/class_threshold",
          schemaPath: "#/properties/class_threshold/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (typeof data0 == "number") {
        if (data0 < 1 || isNaN(data0)) {
          const err2 = {
            instancePath: instancePath + "/class_threshold",
            schemaPath: "#/properties/class_threshold/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 1 },
            message: "must be >= 1",
          };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
      }
    }
  } else {
    const err3 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate32.errors = vErrors;
  return errors === 0;
}
validate32.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const module5 = validate33;
const schema46 = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: false },
    posture: {
      enum: ["critical-only", "balanced", "thorough"],
      default: "thorough",
    },
    max_defects: { type: "integer", minimum: 1 },
    catalog: {
      enum: ["owasp-top10-2025", "asvs-5.0"],
      default: "owasp-top10-2025",
    },
    fail_on: {
      type: "object",
      properties: {
        evidence: {
          enum: ["reproduced", "static_proven", "plausible", "refuted"],
        },
        categories: {
          type: "array",
          items: { enum: ["defect", "risk", "security"] },
          uniqueItems: true,
        },
        states: {
          type: "array",
          items: {
            enum: ["new", "worsened", "pre-existing", "fixed", "unclassified"],
          },
          uniqueItems: true,
        },
        rules: { type: "array", items: { type: "string", minLength: 1 } },
        incomplete: { type: "boolean" },
        required_checks: {
          type: "array",
          items: {
            enum: ["typecheck", "lint", "secrets", "coverage", "dependencies"],
          },
          uniqueItems: true,
        },
      },
      required: [],
      additionalProperties: false,
      default: {
        evidence: "plausible",
        categories: ["security"],
        states: ["new", "worsened"],
        rules: [],
        incomplete: true,
        required_checks: [],
      },
    },
  },
};
function validate33(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate33.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(
        key0 === "enabled" ||
        key0 === "posture" ||
        key0 === "max_defects" ||
        key0 === "catalog" ||
        key0 === "fail_on"
      )) {
        const err0 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.enabled !== undefined) {
      if (typeof data.enabled !== "boolean") {
        const err1 = {
          instancePath: instancePath + "/enabled",
          schemaPath: "#/properties/enabled/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.posture !== undefined) {
      let data1 = data.posture;
      if (!(
        data1 === "critical-only" ||
        data1 === "balanced" ||
        data1 === "thorough"
      )) {
        const err2 = {
          instancePath: instancePath + "/posture",
          schemaPath: "#/properties/posture/enum",
          keyword: "enum",
          params: { allowedValues: schema46.properties.posture.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.max_defects !== undefined) {
      let data2 = data.max_defects;
      if (!(typeof data2 == "number" && !(data2 % 1) && !isNaN(data2))) {
        const err3 = {
          instancePath: instancePath + "/max_defects",
          schemaPath: "#/properties/max_defects/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
      if (typeof data2 == "number") {
        if (data2 < 1 || isNaN(data2)) {
          const err4 = {
            instancePath: instancePath + "/max_defects",
            schemaPath: "#/properties/max_defects/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 1 },
            message: "must be >= 1",
          };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
      }
    }
    if (data.catalog !== undefined) {
      let data3 = data.catalog;
      if (!(data3 === "owasp-top10-2025" || data3 === "asvs-5.0")) {
        const err5 = {
          instancePath: instancePath + "/catalog",
          schemaPath: "#/properties/catalog/enum",
          keyword: "enum",
          params: { allowedValues: schema46.properties.catalog.enum },
          message: "must be equal to one of the allowed values",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.fail_on !== undefined) {
      let data4 = data.fail_on;
      if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
        for (const key1 in data4) {
          if (!(
            key1 === "evidence" ||
            key1 === "categories" ||
            key1 === "states" ||
            key1 === "rules" ||
            key1 === "incomplete" ||
            key1 === "required_checks"
          )) {
            const err6 = {
              instancePath: instancePath + "/fail_on",
              schemaPath: "#/properties/fail_on/additionalProperties",
              keyword: "additionalProperties",
              params: { additionalProperty: key1 },
              message: "must NOT have additional properties",
            };
            if (vErrors === null) {
              vErrors = [err6];
            } else {
              vErrors.push(err6);
            }
            errors++;
          }
        }
        if (data4.evidence !== undefined) {
          let data5 = data4.evidence;
          if (!(
            data5 === "reproduced" ||
            data5 === "static_proven" ||
            data5 === "plausible" ||
            data5 === "refuted"
          )) {
            const err7 = {
              instancePath: instancePath + "/fail_on/evidence",
              schemaPath: "#/properties/fail_on/properties/evidence/enum",
              keyword: "enum",
              params: {
                allowedValues:
                  schema46.properties.fail_on.properties.evidence.enum,
              },
              message: "must be equal to one of the allowed values",
            };
            if (vErrors === null) {
              vErrors = [err7];
            } else {
              vErrors.push(err7);
            }
            errors++;
          }
        }
        if (data4.categories !== undefined) {
          let data6 = data4.categories;
          if (Array.isArray(data6)) {
            const len0 = data6.length;
            for (let i0 = 0; i0 < len0; i0++) {
              let data7 = data6[i0];
              if (!(
                data7 === "defect" ||
                data7 === "risk" ||
                data7 === "security"
              )) {
                const err8 = {
                  instancePath: instancePath + "/fail_on/categories/" + i0,
                  schemaPath:
                    "#/properties/fail_on/properties/categories/items/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema46.properties.fail_on.properties.categories.items
                        .enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err8];
                } else {
                  vErrors.push(err8);
                }
                errors++;
              }
            }
            let i1 = data6.length;
            let j0;
            if (i1 > 1) {
              outer0: for (; i1--;) {
                for (j0 = i1; j0--;) {
                  if (func0(data6[i1], data6[j0])) {
                    const err9 = {
                      instancePath: instancePath + "/fail_on/categories",
                      schemaPath:
                        "#/properties/fail_on/properties/categories/uniqueItems",
                      keyword: "uniqueItems",
                      params: { i: i1, j: j0 },
                      message:
                        "must NOT have duplicate items (items ## " +
                        j0 +
                        " and " +
                        i1 +
                        " are identical)",
                    };
                    if (vErrors === null) {
                      vErrors = [err9];
                    } else {
                      vErrors.push(err9);
                    }
                    errors++;
                    break outer0;
                  }
                }
              }
            }
          } else {
            const err10 = {
              instancePath: instancePath + "/fail_on/categories",
              schemaPath: "#/properties/fail_on/properties/categories/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err10];
            } else {
              vErrors.push(err10);
            }
            errors++;
          }
        }
        if (data4.states !== undefined) {
          let data8 = data4.states;
          if (Array.isArray(data8)) {
            const len1 = data8.length;
            for (let i2 = 0; i2 < len1; i2++) {
              let data9 = data8[i2];
              if (!(
                data9 === "new" ||
                data9 === "worsened" ||
                data9 === "pre-existing" ||
                data9 === "fixed" ||
                data9 === "unclassified"
              )) {
                const err11 = {
                  instancePath: instancePath + "/fail_on/states/" + i2,
                  schemaPath:
                    "#/properties/fail_on/properties/states/items/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema46.properties.fail_on.properties.states.items.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err11];
                } else {
                  vErrors.push(err11);
                }
                errors++;
              }
            }
            let i3 = data8.length;
            let j1;
            if (i3 > 1) {
              outer1: for (; i3--;) {
                for (j1 = i3; j1--;) {
                  if (func0(data8[i3], data8[j1])) {
                    const err12 = {
                      instancePath: instancePath + "/fail_on/states",
                      schemaPath:
                        "#/properties/fail_on/properties/states/uniqueItems",
                      keyword: "uniqueItems",
                      params: { i: i3, j: j1 },
                      message:
                        "must NOT have duplicate items (items ## " +
                        j1 +
                        " and " +
                        i3 +
                        " are identical)",
                    };
                    if (vErrors === null) {
                      vErrors = [err12];
                    } else {
                      vErrors.push(err12);
                    }
                    errors++;
                    break outer1;
                  }
                }
              }
            }
          } else {
            const err13 = {
              instancePath: instancePath + "/fail_on/states",
              schemaPath: "#/properties/fail_on/properties/states/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err13];
            } else {
              vErrors.push(err13);
            }
            errors++;
          }
        }
        if (data4.rules !== undefined) {
          let data10 = data4.rules;
          if (Array.isArray(data10)) {
            const len2 = data10.length;
            for (let i4 = 0; i4 < len2; i4++) {
              let data11 = data10[i4];
              if (typeof data11 === "string") {
                if (func2(data11) < 1) {
                  const err14 = {
                    instancePath: instancePath + "/fail_on/rules/" + i4,
                    schemaPath:
                      "#/properties/fail_on/properties/rules/items/minLength",
                    keyword: "minLength",
                    params: { limit: 1 },
                    message: "must NOT have fewer than 1 characters",
                  };
                  if (vErrors === null) {
                    vErrors = [err14];
                  } else {
                    vErrors.push(err14);
                  }
                  errors++;
                }
              } else {
                const err15 = {
                  instancePath: instancePath + "/fail_on/rules/" + i4,
                  schemaPath:
                    "#/properties/fail_on/properties/rules/items/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err15];
                } else {
                  vErrors.push(err15);
                }
                errors++;
              }
            }
          } else {
            const err16 = {
              instancePath: instancePath + "/fail_on/rules",
              schemaPath: "#/properties/fail_on/properties/rules/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err16];
            } else {
              vErrors.push(err16);
            }
            errors++;
          }
        }
        if (data4.incomplete !== undefined) {
          if (typeof data4.incomplete !== "boolean") {
            const err17 = {
              instancePath: instancePath + "/fail_on/incomplete",
              schemaPath: "#/properties/fail_on/properties/incomplete/type",
              keyword: "type",
              params: { type: "boolean" },
              message: "must be boolean",
            };
            if (vErrors === null) {
              vErrors = [err17];
            } else {
              vErrors.push(err17);
            }
            errors++;
          }
        }
        if (data4.required_checks !== undefined) {
          let data13 = data4.required_checks;
          if (Array.isArray(data13)) {
            const len3 = data13.length;
            for (let i5 = 0; i5 < len3; i5++) {
              let data14 = data13[i5];
              if (!(
                data14 === "typecheck" ||
                data14 === "lint" ||
                data14 === "secrets" ||
                data14 === "coverage" ||
                data14 === "dependencies"
              )) {
                const err18 = {
                  instancePath: instancePath + "/fail_on/required_checks/" + i5,
                  schemaPath:
                    "#/properties/fail_on/properties/required_checks/items/enum",
                  keyword: "enum",
                  params: {
                    allowedValues:
                      schema46.properties.fail_on.properties.required_checks
                        .items.enum,
                  },
                  message: "must be equal to one of the allowed values",
                };
                if (vErrors === null) {
                  vErrors = [err18];
                } else {
                  vErrors.push(err18);
                }
                errors++;
              }
            }
            let i6 = data13.length;
            let j2;
            if (i6 > 1) {
              outer2: for (; i6--;) {
                for (j2 = i6; j2--;) {
                  if (func0(data13[i6], data13[j2])) {
                    const err19 = {
                      instancePath: instancePath + "/fail_on/required_checks",
                      schemaPath:
                        "#/properties/fail_on/properties/required_checks/uniqueItems",
                      keyword: "uniqueItems",
                      params: { i: i6, j: j2 },
                      message:
                        "must NOT have duplicate items (items ## " +
                        j2 +
                        " and " +
                        i6 +
                        " are identical)",
                    };
                    if (vErrors === null) {
                      vErrors = [err19];
                    } else {
                      vErrors.push(err19);
                    }
                    errors++;
                    break outer2;
                  }
                }
              }
            }
          } else {
            const err20 = {
              instancePath: instancePath + "/fail_on/required_checks",
              schemaPath:
                "#/properties/fail_on/properties/required_checks/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err20];
            } else {
              vErrors.push(err20);
            }
            errors++;
          }
        }
      } else {
        const err21 = {
          instancePath: instancePath + "/fail_on",
          schemaPath: "#/properties/fail_on/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err21];
        } else {
          vErrors.push(err21);
        }
        errors++;
      }
    }
  } else {
    const err22 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err22];
    } else {
      vErrors.push(err22);
    }
    errors++;
  }
  validate33.errors = vErrors;
  return errors === 0;
}
validate33.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const module6 = validate34;
const schema47 = {
  type: "object",
  additionalProperties: false,
  properties: {
    sensitive_paths: {
      type: "array",
      items: { type: "string", minLength: 1 },
      default: [],
    },
    public_contracts: { type: "boolean", default: true },
    dependency_changes: { type: "boolean", default: true },
    missing_coverage: { type: "boolean", default: true },
    fan_out_high: { type: "integer", minimum: 1, default: 20 },
  },
};
function validate34(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate34.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(
        key0 === "sensitive_paths" ||
        key0 === "public_contracts" ||
        key0 === "dependency_changes" ||
        key0 === "missing_coverage" ||
        key0 === "fan_out_high"
      )) {
        const err0 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.sensitive_paths !== undefined) {
      let data0 = data.sensitive_paths;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data1 = data0[i0];
          if (typeof data1 === "string") {
            if (func2(data1) < 1) {
              const err1 = {
                instancePath: instancePath + "/sensitive_paths/" + i0,
                schemaPath: "#/properties/sensitive_paths/items/minLength",
                keyword: "minLength",
                params: { limit: 1 },
                message: "must NOT have fewer than 1 characters",
              };
              if (vErrors === null) {
                vErrors = [err1];
              } else {
                vErrors.push(err1);
              }
              errors++;
            }
          } else {
            const err2 = {
              instancePath: instancePath + "/sensitive_paths/" + i0,
              schemaPath: "#/properties/sensitive_paths/items/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err2];
            } else {
              vErrors.push(err2);
            }
            errors++;
          }
        }
      } else {
        const err3 = {
          instancePath: instancePath + "/sensitive_paths",
          schemaPath: "#/properties/sensitive_paths/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.public_contracts !== undefined) {
      if (typeof data.public_contracts !== "boolean") {
        const err4 = {
          instancePath: instancePath + "/public_contracts",
          schemaPath: "#/properties/public_contracts/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.dependency_changes !== undefined) {
      if (typeof data.dependency_changes !== "boolean") {
        const err5 = {
          instancePath: instancePath + "/dependency_changes",
          schemaPath: "#/properties/dependency_changes/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.missing_coverage !== undefined) {
      if (typeof data.missing_coverage !== "boolean") {
        const err6 = {
          instancePath: instancePath + "/missing_coverage",
          schemaPath: "#/properties/missing_coverage/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.fan_out_high !== undefined) {
      let data5 = data.fan_out_high;
      if (!(typeof data5 == "number" && !(data5 % 1) && !isNaN(data5))) {
        const err7 = {
          instancePath: instancePath + "/fan_out_high",
          schemaPath: "#/properties/fan_out_high/type",
          keyword: "type",
          params: { type: "integer" },
          message: "must be integer",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
      if (typeof data5 == "number") {
        if (data5 < 1 || isNaN(data5)) {
          const err8 = {
            instancePath: instancePath + "/fan_out_high",
            schemaPath: "#/properties/fan_out_high/minimum",
            keyword: "minimum",
            params: { comparison: ">=", limit: 1 },
            message: "must be >= 1",
          };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
      }
    }
  } else {
    const err9 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err9];
    } else {
      vErrors.push(err9);
    }
    errors++;
  }
  validate34.errors = vErrors;
  return errors === 0;
}
validate34.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
export const module7 = validate35;
const schema48 = {
  type: "object",
  additionalProperties: false,
  properties: { run: { type: "boolean", default: true } },
};
function validate35(
  data,
  {
    instancePath = "",
    parentData,
    parentDataProperty,
    rootData = data,
    dynamicAnchors = {},
  } = {},
) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate35.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = undefined;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = undefined;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "run")) {
        const err0 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.run !== undefined) {
      if (typeof data.run !== "boolean") {
        const err1 = {
          instancePath: instancePath + "/run",
          schemaPath: "#/properties/run/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
  } else {
    const err2 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err2];
    } else {
      vErrors.push(err2);
    }
    errors++;
  }
  validate35.errors = vErrors;
  return errors === 0;
}
validate35.evaluated = {
  props: true,
  dynamicProps: false,
  dynamicItems: false,
};
