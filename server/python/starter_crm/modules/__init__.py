"""Your modules: one file per module, each defining ``MODULE``. See ``module_runtime.py`` for the shape.

Every ``.py`` file in this folder whose name does not start with an underscore is loaded at boot. The built-in example
is ``deals.py``; ``npm run new:module -- tickets`` copies it. Nothing in core names a module, so adding or removing a
file never touches core and upstream upgrades stay mergeable.
"""
