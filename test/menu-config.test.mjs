import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadMenuConfig } from './load-menu-config.mjs';

const api = loadMenuConfig();

// Trimmed copy of the phase-1 starter file (docstring + comments inside the
// list must be handled).
const STARTER = `"""The list of missions your hub menu shows, in the order it shows them.

    "display"   (required) What shows on the hub screen for this slot.
"""

MENU_ITEMS = [
    {"display": 1, "module": "mission_01_go_out_and_turn", "function": "run"},
    {"display": 2, "module": "mission_02_come_back_home", "function": "run"},
    # Whole program (a block program or a Python file) — picking it runs
    # the entire file from top to bottom:
    # {"display": 3, "module": "my_blocks_program"},
    # {"display": 4, "module": "arm_moves", "function": "lift_arm", "blocks": True},
]
`;

describe('parseMenuConfig', () => {
    test('parses the phase-1 starter file (docstring + comments in list)', () => {
        const { items, error } = api.parseMenuConfig(STARTER);
        assert.equal(error, null);
        assert.deepEqual(items, [
            { display: 1, module: 'mission_01_go_out_and_turn', function: 'run' },
            { display: 2, module: 'mission_02_come_back_home', function: 'run' },
        ]);
    });
    test('parses True/False/None, patterns, escapes', () => {
        const src = 'MENU_ITEMS = [\n' +
            '    {"display": ["#####", "#   #", "#   #", "#   #", "#####"], "module": "box", "function": None, "blocks": True, "enabled": False},\n' +
            "    {'display': 'A', 'module': 'quoted', 'function': 'say_\\'hi\\''},\n" +
            ']\n';
        const { items, error } = api.parseMenuConfig(src);
        assert.equal(error, null);
        assert.equal(items[0].blocks, true);
        assert.equal(items[0].enabled, false);
        assert.equal(items[0].function, null);
        assert.deepEqual(items[0].display, ['#####', '#   #', '#   #', '#   #', '#####']);
        assert.equal(items[1].function, "say_'hi'");
    });
    test('missing MENU_ITEMS -> error, null items', () => {
        const r = api.parseMenuConfig('print("hello")\n');
        assert.equal(r.items, null);
        assert.match(r.error, /MENU_ITEMS/);
    });
    test('MENU_ITEMS not a list -> error', () => {
        assert.notEqual(api.parseMenuConfig('MENU_ITEMS = {"a": 1}\n').error, null);
    });
    test('non-dict entry -> error', () => {
        assert.notEqual(api.parseMenuConfig('MENU_ITEMS = [1, 2]\n').error, null);
    });
    test('unterminated string -> error (never throws)', () => {
        assert.notEqual(api.parseMenuConfig('MENU_ITEMS = [{"display": 1, "module": "oops]\n').error, null);
    });
    test('indented MENU_ITEMS is not top-level -> error', () => {
        assert.notEqual(api.parseMenuConfig('if True:\n    MENU_ITEMS = []\n').error, null);
    });
});

describe('generateMenuConfig', () => {
    test('round-trips through parseMenuConfig', () => {
        const items = [
            { display: 1, module: 'mission_01', function: 'run' },
            { display: 'A', module: 'arm_moves', function: 'lift_arm', blocks: true },
            { display: ['#####', '#   #', '#   #', '#   #', '#####'], module: 'box' },
            { display: 9, module: 'later', enabled: false },
        ];
        const text = api.generateMenuConfig(items);
        const back = api.parseMenuConfig(text);
        assert.equal(back.error, null);
        assert.deepEqual(back.items, items);
    });
    test('normalizes defaults away: function None, blocks False, enabled True omitted', () => {
        const text = api.generateMenuConfig([
            { display: 1, module: 'm', function: null, blocks: false, enabled: true },
        ]);
        assert.match(text, /\{"display": 1, "module": "m"\},/);
    });
    test('keeps unknown keys (forward compat)', () => {
        const text = api.generateMenuConfig([{ display: 1, module: 'm', color: 'red' }]);
        assert.match(text, /"color": "red"/);
    });
    test('starts with a docstring and contains exactly one MENU_ITEMS', () => {
        const text = api.generateMenuConfig([]);
        assert.match(text, /^"""/);
        assert.equal(text.match(/^MENU_ITEMS\s*=/gm).length, 1);
    });
});

// main.py picks slots with `__import__(item["module"])` — a string, invisible to
// every static bundler — so generateMenuConfig emits a guarded hint block. These
// tests pin the three things that make it work: the imports are there, the guard
// never runs them, and the guard survives the compiler's constant folding.
describe('generateMenuConfig bundle hints', () => {
    const ITEMS = [
        { display: 1, module: 'mission_01_go_out_and_turn', function: 'run' },
        { display: 2, module: 'my_blocks_program' },
        { display: 3, module: 'arm_moves', function: 'lift_arm', blocks: true },
        { display: 4, module: 'arm_moves', function: 'drop_arm', blocks: true },
        { display: 9, module: 'me05', function: 'run', enabled: false },
    ];

    test('emits a guarded import for every item kind', () => {
        const text = api.generateMenuConfig(ITEMS);
        assert.match(text, /^_BUNDLE_HINTS = False$/m);
        assert.match(text, /^if _BUNDLE_HINTS:$/m);
        // function-item, whole-program item, and blocks: True item alike
        assert.match(text, /^    import mission_01_go_out_and_turn$/m);
        assert.match(text, /^    import my_blocks_program$/m);
        assert.match(text, /^    import arm_moves$/m);
    });
    test('emits for disabled slots too (a kid can flip enabled back to True)', () => {
        assert.match(api.generateMenuConfig(ITEMS), /^    import me05$/m);
    });
    test('never emits a bare top-level import', () => {
        const text = api.generateMenuConfig(ITEMS);
        assert.equal(text.match(/^import /gm), null);
    });
    test('dedupes module names, preserving list order', () => {
        assert.deepEqual(api.bundleHintModules(ITEMS), [
            'mission_01_go_out_and_turn', 'my_blocks_program', 'arm_moves', 'me05',
        ]);
        const imports = api.generateMenuConfig(ITEMS).match(/^    import (\w+)$/gm);
        assert.equal(imports.length, 4);
    });
    test('empty MENU_ITEMS emits no hint block at all', () => {
        // `if` with an empty body is a SyntaxError.
        const text = api.generateMenuConfig([]);
        assert.equal(text.includes('_BUNDLE_HINTS'), false);
        assert.equal(text.includes('import'), false);
    });
    test('drops non-bare / absent module names instead of emitting bad syntax', () => {
        assert.deepEqual(api.bundleHintModules([
            { display: 1, module: 'pkg.mod' },
            { display: 2 },
            { display: 3, module: '' },
            { display: 4, module: 'good_one' },
        ]), ['good_one']);
    });
    test('hints do not disturb the MENU_ITEMS round-trip', () => {
        const back = api.parseMenuConfig(api.generateMenuConfig(ITEMS));
        assert.equal(back.error, null);
        assert.deepEqual(back.items, ITEMS);
    });
    test("parseMenuConfig's ^MENU_ITEMS\\s*= anchor still finds exactly one match", () => {
        const text = api.generateMenuConfig(ITEMS);
        assert.equal(text.match(/^MENU_ITEMS\s*=/gm).length, 1);
    });
});

// These need the real `python3` binary, like the git engine needs `git` and
// test/pack.test.mjs needs `unzip`. They are the only proof that the generated
// file actually compiles and that a static bundler actually sees the hints.
describe('generateMenuConfig bundle hints (real python3)', () => {
    const ITEMS = [
        { display: 1, module: 'mission_01_go_out_and_turn', function: 'run' },
        { display: 2, module: 'my_blocks_program' },
        { display: 9, module: 'gone_missing', enabled: false },
    ];

    function py(script, cwd) {
        return execFileSync('python3', ['-c', script], { encoding: 'utf8', cwd }).trim();
    }

    test('generated file is valid Python with the docstring still first', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'pybricks-menucfg-'));
        writeFileSync(path.join(dir, 'menu_config.py'), api.generateMenuConfig(ITEMS));
        const out = py(
            'import ast;' +
            'm=ast.parse(open("menu_config.py").read(), "menu_config.py");' +
            'print(ast.get_docstring(m) is not None, [type(n).__name__ for n in m.body])',
            dir,
        );
        // docstring present, then exactly the hint assignment, the guard, and MENU_ITEMS
        assert.equal(out, "True ['Expr', 'Assign', 'If', 'Assign']");
    });

    test('importing it runs nothing: MENU_ITEMS loads, hinted modules stay unimported', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'pybricks-menucfg-'));
        writeFileSync(path.join(dir, 'menu_config.py'), api.generateMenuConfig(ITEMS));
        // A hinted module that WOULD blow up (and print) if the guard ever ran.
        writeFileSync(path.join(dir, 'my_blocks_program.py'), 'raise SystemExit("hint ran!")\n');
        writeFileSync(path.join(dir, 'mission_01_go_out_and_turn.py'), 'def run(robot):\n    pass\n');
        const out = py(
            'import sys, menu_config;' +
            'print(len(menu_config.MENU_ITEMS),' +
            ' "my_blocks_program" in sys.modules,' +
            ' menu_config._BUNDLE_HINTS)',
            dir,
        );
        assert.equal(out, '3 False False');
    });

    test("ModuleFinder resolves every slot module (the bug this block exists for)", () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'pybricks-menucfg-'));
        writeFileSync(path.join(dir, 'menu_config.py'), api.generateMenuConfig(ITEMS));
        // Stand-in for the starter's main.py: imports the config, then reaches the
        // slot modules only through a STRING, exactly as the real loader does.
        writeFileSync(
            path.join(dir, 'main.py'),
            'from menu_config import MENU_ITEMS\n' +
            'for item in MENU_ITEMS:\n    __import__(item["module"])\n',
        );
        writeFileSync(path.join(dir, 'mission_01_go_out_and_turn.py'), 'def run(robot):\n    pass\n');
        writeFileSync(path.join(dir, 'my_blocks_program.py'), 'x = 1\n');
        const out = py(
            'from modulefinder import ModuleFinder;' +
            'f=ModuleFinder(["."]); f.run_script("main.py");' +
            'print(sorted(n for n,m in f.modules.items() if getattr(m,"__file__",None)))',
            dir,
        );
        assert.equal(
            out,
            "['__main__', 'menu_config', 'mission_01_go_out_and_turn', 'my_blocks_program']",
        );
    });

    test('a hinted module with no file is harmless (ModuleFinder just records it)', () => {
        // `gone_missing` above has no .py file — the previous test already proved
        // ModuleFinder does not raise. Pin that it lands in badmodules instead.
        const dir = mkdtempSync(path.join(tmpdir(), 'pybricks-menucfg-'));
        writeFileSync(path.join(dir, 'menu_config.py'), api.generateMenuConfig(ITEMS));
        writeFileSync(path.join(dir, 'main.py'), 'import menu_config\n');
        const out = py(
            'from modulefinder import ModuleFinder;' +
            'f=ModuleFinder(["."]); f.run_script("main.py");' +
            'print("gone_missing" in f.badmodules)',
            dir,
        );
        assert.equal(out, 'True');
    });
});

describe('validateDisplay / validateItem', () => {
    test('accepts int 0-99, rejects bools, negatives, 100', () => {
        assert.equal(api.validateDisplay(0), null);
        assert.equal(api.validateDisplay(99), null);
        assert.notEqual(api.validateDisplay(true), null);
        assert.notEqual(api.validateDisplay(-1), null);
        assert.notEqual(api.validateDisplay(100), null);
        assert.notEqual(api.validateDisplay(1.5), null);
    });
    test('accepts exactly-1-char strings', () => {
        assert.equal(api.validateDisplay('A'), null);
        assert.notEqual(api.validateDisplay(''), null);
        assert.notEqual(api.validateDisplay('AB'), null);
    });
    test('accepts 5x5 patterns only', () => {
        assert.equal(api.validateDisplay(['#####', '     ', '#####', '     ', '#####']), null);
        assert.notEqual(api.validateDisplay(['#####']), null);
        assert.notEqual(api.validateDisplay(['####', '     ', '#####', '     ', '#####']), null);
        assert.notEqual(api.validateDisplay([1, 2, 3, 4, 5]), null);
    });
    test('validateItem: module must be bare identifier; function plain name; flags boolean', () => {
        assert.equal(api.validateItem({ display: 1, module: 'ok_name' }), null);
        assert.notEqual(api.validateItem({ display: 1, module: 'pkg.mod' }), null);
        assert.notEqual(api.validateItem({ display: 1 }), null);
        assert.notEqual(api.validateItem({ module: 'm' }), null);
        assert.notEqual(api.validateItem({ display: 1, module: 'm', function: 'not a name' }), null);
        assert.notEqual(api.validateItem({ display: 1, module: 'm', blocks: 1 }), null);
        assert.equal(api.validateItem({ display: 1, module: 'm', function: null }), null);
    });
});

describe('analyzeProgram', () => {
    const BLOCKS_MAIN = '# pybricks blocks file:{"whatever": true}\n' +
        'from pybricks.tools import run_task, wait\n\n' +
        'async def main():\n    await wait(100)\n\n' +
        'run_task(main())\n';
    const BLOCKS_SETUP = '# pybricks blocks file:{"whatever": true}\n' +
        'from pybricks.pupdevices import Motor\nfrom pybricks.parameters import Port\n\n' +
        'left_motor = Motor(Port.A)\n\n' +
        'def lift_arm():\n    left_motor.run_angle(500, 90)\n\n' +
        'async def wave():\n    left_motor.run_angle(500, -90)\n';
    const PLAIN_MISSION = '"""Mission 1."""\n\nfrom robot import Robot\n\n\ndef run(robot):\n    robot.drive.straight(200)\n';

    test('block main program: isBlocks, run_task disqualifies methods', () => {
        const r = api.analyzeProgram('my_program.py', BLOCKS_MAIN);
        assert.deepEqual(r, { module: 'my_program', isBlocks: true, setupOnly: false, methods: [], wholeProgram: true });
    });
    test('block setup-only file: methods listed, async included', () => {
        const r = api.analyzeProgram('arm_moves.py', BLOCKS_SETUP);
        assert.equal(r.isBlocks, true);
        assert.equal(r.setupOnly, true);
        assert.deepEqual(r.methods, ['lift_arm', 'wave']);
    });
    test('plain mission module: setup-only with run()', () => {
        const r = api.analyzeProgram('mission_01.py', PLAIN_MISSION);
        assert.deepEqual(r, { module: 'mission_01', isBlocks: false, setupOnly: true, methods: ['run'], wholeProgram: true });
    });
    test('top-level call disqualifies (trailing main statement)', () => {
        const src = 'def go():\n    pass\n\ngo()\n';
        assert.deepEqual(api.analyzeProgram('x.py', src).methods, []);
    });
    test('top-level for/if disqualifies', () => {
        assert.equal(api.analyzeProgram('x.py', 'for i in range(3):\n    pass\n').setupOnly, false);
        assert.equal(api.analyzeProgram('x.py', 'if True:\n    pass\n').setupOnly, false);
    });
    test('assignments, imports, class, decorator, docstring are all setup', () => {
        const src = '"""Doc."""\nimport math\nfrom pybricks.parameters import Port\n' +
            'SPEED = 500\nnames = ["a", "b"]\nd = {"k": 1}\na, b = 1, 2\nx += 1\n' +
            '@property\ndef f():\n    pass\nclass C:\n    pass\n';
        assert.equal(api.analyzeProgram('x.py', src).setupOnly, true);
    });
    test('kwarg call is NOT mistaken for an assignment', () => {
        assert.equal(api.analyzeProgram('x.py', 'configure(speed=500)\n').setupOnly, false);
    });
    test('underscore-prefixed defs are hidden from methods', () => {
        const r = api.analyzeProgram('x.py', 'def _helper():\n    pass\ndef go():\n    pass\n');
        assert.deepEqual(r.methods, ['go']);
    });
    test('module name: null for dotted/nested/invalid paths', () => {
        assert.equal(api.analyzeProgram('my.file.py', 'x = 1\n').module, null);
        assert.equal(api.analyzeProgram('dir/x.py', 'x = 1\n').module, null);
        assert.equal(api.analyzeProgram('1bad.py', 'x = 1\n').module, null);
        assert.equal(api.analyzeProgram('notpy.txt', 'x = 1\n').module, null);
    });
    test('__main__ guard is setup, and hides whole-program mode', () => {
        const src = 'from robot import Robot\n\ndef run(robot):\n    pass\n\n' +
            'if __name__ == "__main__":\n    run(Robot())\n';
        assert.deepEqual(api.analyzeProgram('dance.py', src), {
            module: 'dance', isBlocks: false, setupOnly: true, methods: ['run'], wholeProgram: false,
        });
        const single = "def go():\n    pass\nif __name__=='__main__':\n    go()\n";
        assert.equal(api.analyzeProgram('x.py', single).wholeProgram, false);
    });
    test('__main__ guard next to other top-level code keeps whole-program mode', () => {
        const src = 'def go():\n    pass\ngo()\nif __name__ == "__main__":\n    go()\n';
        const r = api.analyzeProgram('x.py', src);
        assert.equal(r.setupOnly, false);
        assert.equal(r.wholeProgram, true);
    });
    test('other if statements are not mistaken for a __main__ guard', () => {
        assert.equal(api.analyzeProgram('x.py', 'if __name__ != "__main__":\n    pass\n').setupOnly, false);
        assert.equal(api.analyzeProgram('x.py', 'if __name__ == "other":\n    pass\n').setupOnly, false);
    });
    test('setup-only file without a __main__ guard keeps whole-program mode', () => {
        assert.equal(api.analyzeProgram('x.py', 'def go():\n    pass\n').wholeProgram, true);
    });
    test('multiline constructs do not register as new statements', () => {
        const src = 'ITEMS = [\n    1,\n    2,\n]\nLONG = (\n    "a"\n    "b"\n)\ns = """text\nrun_task( inside a string\n"""\n';
        assert.equal(api.analyzeProgram('x.py', src).setupOnly, true);
    });
});

describe('nextFreeDisplayNumber', () => {
    test('picks the smallest unused 1..99, then 0', () => {
        assert.equal(api.nextFreeDisplayNumber([]), 1);
        assert.equal(api.nextFreeDisplayNumber([{ display: 1 }, { display: 2 }]), 3);
        assert.equal(api.nextFreeDisplayNumber([{ display: 1 }, { display: 3 }]), 2);
        assert.equal(api.nextFreeDisplayNumber([{ display: 'A' }]), 1);
    });
});
