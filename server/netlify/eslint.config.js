import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['dist/**', '.netlify/**', 'node_modules/**'] },
    js.configs.recommended,
    {
        languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, Response: 'readonly', Request: 'readonly' } },
        rules: {
            semi: ['error', 'always'],
            eqeqeq: ['error', 'smart'],
            'no-unused-vars': ['error', { args: 'none' }]
        }
    }
];
