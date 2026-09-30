// Native app entry: bind Chromium and the Electron bootstrap to one local profile.
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef READ_ALOUD_PROFILE
#error READ_ALOUD_PROFILE must be configured at build time
#endif

int main(int argc, char **argv) {
    char executable[PATH_MAX], resolved[PATH_MAX], native[PATH_MAX];
    uint32_t capacity = sizeof(executable);
    if (_NSGetExecutablePath(executable, &capacity) != 0 || !realpath(executable, resolved)) {
        fprintf(stderr, "Cannot locate the Read Aloud app executable.\n");
        return 1;
    }
    char *slash = strrchr(resolved, '/');
    if (!slash) return 1;
    *slash = '\0';
    int written = snprintf(native, sizeof(native), "%s/ChatGPT-native", resolved);
    if (written < 0 || (size_t)written >= sizeof(native)) return 1;
    if (setenv("CODEX_ELECTRON_USER_DATA_PATH", READ_ALOUD_PROFILE, 1) != 0) return 1;
    char profile_argument[PATH_MAX + 32];
    written = snprintf(profile_argument, sizeof(profile_argument), "--user-data-dir=%s", READ_ALOUD_PROFILE);
    if (written < 0 || (size_t)written >= sizeof(profile_argument)) return 1;
    char **native_args = calloc((size_t)argc + 3, sizeof(char *));
    if (!native_args) return 1;
    native_args[0] = native;
    native_args[1] = profile_argument;
    size_t count = 2;
    for (int i = 1; i < argc; i++) {
        // Avoid conflicting profile arguments from an external launch command.
        if (strncmp(argv[i], "--user-data-dir=", sizeof("--user-data-dir=") - 1) == 0) continue;
        if (strcmp(argv[i], "--user-data-dir") == 0) {
            if (i + 1 < argc) i++;
            continue;
        }
        native_args[count++] = argv[i];
    }
    native_args[count] = NULL;
    execv(native, native_args);
    fprintf(stderr, "Cannot launch ChatGPT Read Aloud: %s\n", strerror(errno));
    free(native_args);
    return 1;
}
