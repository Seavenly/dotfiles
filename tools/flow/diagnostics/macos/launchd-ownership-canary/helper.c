/* Unadmitted ownership observation fixture. Every process self-exits by 20s. */
#define _POSIX_C_SOURCE 200809L
#include <sys/types.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void record(const char *directory, const char *role) {
  char path[4096];
  if (snprintf(path, sizeof(path), "%s/%ld.json", directory, (long)getpid()) >= (int)sizeof(path)) _exit(2);
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) _exit(3);
  dprintf(fd, "{\"pid\":%ld,\"ppid\":%ld,\"group\":%ld,\"session\":%ld,\"role\":\"%s\"}\n",
          (long)getpid(), (long)getppid(), (long)getpgrp(), (long)getsid(0), role);
  close(fd);
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  alarm(20);
  record(argv[1], "root");
  pid_t ordinary = fork();
  if (ordinary < 0) return 4;
  if (ordinary == 0) { alarm(20); record(argv[1], "fork"); sleep(8); _exit(0); }
  pid_t intermediate = fork();
  if (intermediate < 0) return 4;
  if (intermediate == 0) {
    alarm(20); record(argv[1], "intermediate");
    pid_t escaped = fork();
    if (escaped < 0) _exit(4);
    if (escaped == 0) {
      alarm(20);
      if (setsid() < 0) _exit(5);
      record(argv[1], "doublefork-setsid"); sleep(8); _exit(0);
    }
    _exit(0);
  }
  /* Keep the launchd root alive; only the grandchild deliberately escapes. */
  sleep(12);
  while (waitpid(-1, NULL, 0) > 0) {}
  return 0;
}
