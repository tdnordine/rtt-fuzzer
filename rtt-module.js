"use strict"

const fs = require("fs")
const { FuzzedDataProvider } = require("@jazzer.js/core")

const RULES_JS_FILE = process.env.RTT_RULES || "rules.js"
const MAX_STEPS = parseInt(process.env.MAX_STEPS) || 2048
const NO_UNDO = process.env.NO_UNDO === 'true'
const NO_RESIGN = process.env.NO_RESIGN === 'true'
const RND = process.env.RND === 'true'

console.log(`Loading rtt-fuzzer RTT_RULES='${RULES_JS_FILE}' MAX_STEPS=${MAX_STEPS}`)
console.log(`RANDOM='${RND}' NO_UNDO='${NO_UNDO}' NO_RESIGN='${NO_RESIGN}'`)
if (!fs.existsSync(RULES_JS_FILE)) {
    throw Error("rules.js not found, specify via RTT_RULES environment variable.")
}
const RULES = require(RULES_JS_FILE)

function pick(data, a) {
    if (RND) {
        let x = rnd(data, 1, a.length)
        return a[x-1]    
    }

    return data.pickValue(a)
}

function rnd(data, min, max) {
    if (RND) {
        return Math.floor(Math.random() * (max - min + 1) + min)
    }
    return data.consumeIntegralInRange(min, max)
}

module.exports.fuzz = function(fuzzerInputData) {
    let data = new FuzzedDataProvider(fuzzerInputData)
    if (!RND && data.remainingBytes < 16) {
        // insufficient bytes to start
        return -1
    }
    let seed =rnd(data, 1, 2**35-31)
    let scenario = pick(data, RULES.scenarios)

    // TODO randomize options
    const options = {}
    
    let game_setup = {
        "seed": seed,
        "scenario": scenario,
        "options": options
    }
    // console.log(game_setup)
    let state = RULES.setup(seed, scenario, options)

    let step = 0
    while (true) {
        if (!RND && data.remainingBytes < 16) {
            // insufficient bytes to continue
            return -1
        }
        let active = state.active
        if (active === 'Both' || active === 'All') {
            // If multiple players can act, we'll pick a random player to go first.
            active = pick(data, RULES.roles)
        }

        let view = RULES.view(state, active)
        
        if (step > MAX_STEPS) {
            log_crash(game_setup, state, view, step, active)
            throw new MaxStepsExceededError(`Maximum step count (MAX_STEPS=${MAX_STEPS}) exceeded`)
        }
        
        if (state.state === 'game_over') {
            break
        }
        
        if (!view.actions) {
            log_crash(game_setup, state, view, step, active)
            throw new NoMoreActionsError("No actions defined")
        }
        
        let actions = view.actions
        if (NO_UNDO && 'undo' in actions) {
            // remove `undo` from actions, useful to test for dead-ends
            delete actions['undo']
        }
        if (!NO_RESIGN && RULES.resign) {
            actions['_resign'] = 1
        }
        
        // Tor: view.actions["foo"] === 0 means the "foo" action is disabled (show the button in a disabled state)
        // Also ignoring the actions with `[]` as args, unsure about this but needed for Nevsky.
        for (const [key, value] of Object.entries(actions)) {
            if (value === false || value === 0 || value.length === 0) {
                delete actions[key]
            }
        }

        if (Object.keys(actions).length === 0) {
            log_crash(game_setup, state, view, step, active)
            throw new NoMoreActionsError("No more actions to take (besides undo)")
        }
        let action = pick(data, Object.keys(actions))
        let args = actions[action]
        let arg = null

        if (args !== undefined && args !== null && typeof args !== "number" && typeof args !== "boolean") {
            // check for NaN as any suggested action argument and raise an error on those
            for (const arg in args) {
                if (isNaN(arg)) {
                    log_crash(game_setup, state, view, step, active)
                    throw new InvalidActionArgument(`Action '${action}' argument has NaN value`)
                }
            }

            arg = pick(data, args)
        }


        if (RULES.fuzz_log !== undefined)
            RULES.fuzz_log({
                "state": state,
                "view": view,
                "actions" : Object.keys(actions),
                "chosen_action": action,
                "args": args,
                "chosen_arg" : arg
            })        

        try {
            if (action !== "_resign") {
                state = RULES.action(state, active, action, arg)
            } else {
                state = RULES.resign(state, active)
            }
        } catch (e) {
            log_crash(game_setup, state, view, step, active, action, arg)
            throw new RulesCrashError(e, e.stack)
        }
        step += 1
    }
}


function log_crash(game_setup, state, view, step, active, action=undefined, args=undefined) {
    console.log()
    // console.log("STATE", state)
    //console.log("GAME", game_setup)
    console.log("VIEW", view)
    if (action !== undefined) {
        console.log(`STEP=${step} ACTIVE=${active} ACTION: ${action} ` + JSON.stringify(args))
    } else {
        console.log(`STEP=${step} ACTIVE=${active}`)
    }
    console.log("STATE dumped to 'crash-state.json'\n")
    fs.writeFileSync("crash-state.json", JSON.stringify(state))
}

// Custom Error classes, allowing us to ignore expected errors with -x
class MaxStepsExceededError extends Error {
    constructor(message) {
      super(message)
      this.name = "MaxStepsExceededError"
    }
}

class NoMoreActionsError extends Error {
    constructor(message) {
      super(message)
      this.name = "NoMoreActionsError"
    }
}

class InvalidActionArgument extends Error {
    constructor(message) {
      super(message)
      this.name = "InvalidActionArgument"
    }
}

class RulesCrashError extends Error {
    constructor(message, stack) {
      super(message)
      this.name = "RulesCrashError";
      this.stack = stack
    }
}
