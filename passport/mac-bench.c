/* kula · the Mac's native measurement (21.10.2026). mac.sh compiles this when the Mac has
   Apple's command line tools and prints what it says into the passport. The same three tests
   as the phone's Measure.kt / Probe.kt, so a Mac and a phone stand side by side:

     copy    256 MB copied end to end (first half -> second, then back), one warm-up, three
             timed passes; traffic per pass = read + write = 2 x size      -> mem_bw_gbs
     read    the same buffer summed by 1, 2, 4, P and N threads, one slice each; the best
             count wins                                                      -> bw_threads,
                                                                                mem_bw_read_gbs,
                                                                                best_threads
     matmul  512 x 512 floats, rows split over every core, one warm-up, three timed
             GFLOPS = 3 x 2n^3 / time                                        -> gflops

   Output: one key=value per line. Usage: mac-bench <performance cores> <all cores> */
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

#define MB (1024UL * 1024UL)
static uint64_t *buf;
static size_t words;

typedef struct { size_t from, to; uint64_t sum; } slice_t;

static void *read_slice(void *arg) {
  slice_t *s = arg;
  uint64_t a = 0, b = 0, c = 0, d = 0;
  for (size_t i = s->from; i + 4 <= s->to; i += 4) { a += buf[i]; b += buf[i + 1]; c += buf[i + 2]; d += buf[i + 3]; }
  s->sum = a + b + c + d;
  return NULL;
}

static double read_bw(int threads) {
  pthread_t th[64];
  slice_t sl[64];
  double best = 0;
  for (int rep = 0; rep < 4; rep++) { /* the first pass warms up; the best of the other three counts */
    size_t per = words / threads;
    double t0 = now();
    for (int i = 0; i < threads; i++) {
      sl[i].from = i * per; sl[i].to = (i == threads - 1) ? words : (i + 1) * per;
      pthread_create(&th[i], NULL, read_slice, &sl[i]);
    }
    for (int i = 0; i < threads; i++) pthread_join(th[i], NULL);
    double sec = now() - t0;
    double gbs = (double)words * 8 / sec / 1e9;
    if (rep > 0 && gbs > best) best = gbs;
  }
  return best;
}

static double copy_bw(void) {
  size_t half = words / 2 * 8;
  char *p = (char *)buf;
  memcpy(p + half, p, half); memcpy(p, p + half, half); /* warm-up */
  double t0 = now();
  for (int r = 0; r < 3; r++) { memcpy(p + half, p, half); memcpy(p, p + half, half); }
  double sec = now() - t0;
  return 2.0 * (double)(words * 8) * 3 / sec / 1e9;
}

#define N 512
static float A[N * N], B[N * N], C[N * N];
typedef struct { int r0, r1; } rows_t;
static void *mul_rows(void *arg) {
  rows_t *r = arg;
  for (int i = r->r0; i < r->r1; i++) {
    float *ci = C + i * N;
    memset(ci, 0, N * sizeof(float));
    for (int k = 0; k < N; k++) {
      float aik = A[i * N + k];
      const float *bk = B + k * N;
      for (int j = 0; j < N; j++) ci[j] += aik * bk[j];
    }
  }
  return NULL;
}
static void multiply(int workers) {
  pthread_t th[64];
  rows_t rs[64];
  int per = (N + workers - 1) / workers, used = 0;
  for (int w = 0; w < workers; w++) {
    rs[w].r0 = w * per; rs[w].r1 = (w + 1) * per > N ? N : (w + 1) * per;
    if (rs[w].r0 >= rs[w].r1) break;
    pthread_create(&th[used], NULL, mul_rows, &rs[w]);
    used++;
  }
  for (int i = 0; i < used; i++) pthread_join(th[i], NULL);
}
static double gflops(int workers) {
  for (int i = 0; i < N * N; i++) { A[i] = (i % 7) * 0.5f; B[i] = (i % 5) * 0.25f; }
  multiply(workers); /* warm-up */
  double t0 = now();
  for (int r = 0; r < 3; r++) multiply(workers);
  double sec = now() - t0;
  return 3.0 * 2.0 * N * N * (double)N / sec / 1e9;
}

int main(int argc, char **argv) {
  int perf = argc > 1 ? atoi(argv[1]) : 4, all = argc > 2 ? atoi(argv[2]) : perf;
  if (perf < 1) perf = 1;
  if (all < perf) all = perf;
  if (all > 64) all = 64;
  size_t bytes = 256 * MB;
  buf = malloc(bytes);
  if (!buf) { bytes = 64 * MB; buf = malloc(bytes); }
  if (!buf) return 1;
  words = bytes / 8;
  for (size_t i = 0; i < words; i++) buf[i] = i;

  printf("mem_bw_gbs=%.2f\n", copy_bw());
  int counts[5] = {1, 2, 4, perf, all}, best_t = 1;
  double best = 0;
  printf("bw_threads=");
  int seen[65] = {0}, first = 1;
  for (int k = 0; k < 5; k++) {
    int t = counts[k];
    if (t < 1 || t > all || seen[t]) continue;
    seen[t] = 1;
    double g = read_bw(t);
    printf("%s%d:%.1f", first ? "" : ",", t, g);
    first = 0;
    if (g > best) { best = g; best_t = t; }
  }
  printf("\nmem_bw_read_gbs=%.1f\nbest_threads=%d\n", best, best_t);
  printf("gflops=%.2f\n", gflops(all));
  free(buf);
  return 0;
}
