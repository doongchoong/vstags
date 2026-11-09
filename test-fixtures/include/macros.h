/* 시뮬레이터 회귀 테스트용 매크로 */
#ifndef MACROS_H
#define MACROS_H

/* 25줄이 넘는 매크로: 색인의 호버용 sig 는 잘림 */
#define CHECK_ERR(x) do { \
    if (x) { \
        trace_line(0); \
        trace_line(1); \
        trace_line(2); \
        trace_line(3); \
        trace_line(4); \
        trace_line(5); \
        trace_line(6); \
        trace_line(7); \
        trace_line(8); \
        trace_line(9); \
        trace_line(10); \
        trace_line(11); \
        trace_line(12); \
        trace_line(13); \
        trace_line(14); \
        trace_line(15); \
        trace_line(16); \
        trace_line(17); \
        trace_line(18); \
        trace_line(19); \
        trace_line(20); \
        trace_line(21); \
        trace_line(22); \
        trace_line(23); \
        trace_line(24); \
        trace_line(25); \
        trace_line(26); \
        trace_line(27); \
        trace_line(28); \
        trace_line(29); \
        err_count++; \
    } \
} while (0)

#define EMPTY_TRACE
#define PRINT_STRUCT(s) print_struct(#s, (void *)&(s))
/* 구조체 멤버와 같은 이름의 매크로 */
#define count 5

struct counter { int count; int total; };
extern int err_count;

#endif
