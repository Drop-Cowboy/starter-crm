import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

// The starter is teaching code, so documentation is enforced, not suggested
// (plan section 9.1). Every exported function and class in src/ needs a JSDoc
// block that names its parameters, its return value and what it throws.
export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: globals.node
        },
        rules: {
            'semi': ['error', 'always'],
            'eqeqeq': ['error', 'smart'],
            'no-unused-vars': ['error', { args: 'none' }]
        }
    },
    {
        files: ['src/**/*.js'],
        plugins: { jsdoc },
        rules: {
            'jsdoc/require-jsdoc': ['error', {
                publicOnly: true,
                require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true, ArrowFunctionExpression: true, FunctionExpression: true },
                contexts: ['ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression']
            }],
            'jsdoc/require-description': ['error', { contexts: ['any'] }],
            'jsdoc/require-param': ['error', { checkDestructured: false }],
            'jsdoc/require-param-description': 'error',
            'jsdoc/require-param-name': 'error',
            'jsdoc/require-param-type': 'error',
            'jsdoc/require-returns': ['error', { forceReturnsWithAsync: false }],
            'jsdoc/require-returns-description': 'error',
            'jsdoc/require-returns-type': 'error',
            'jsdoc/require-throws': 'error',
            'jsdoc/check-param-names': ['error', { checkDestructured: false }],
            'jsdoc/check-types': 'error',
            'jsdoc/no-undefined-types': 'off'
        }
    }
];
