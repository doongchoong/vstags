#include "common.h"

static int counter;
int g_table_size = 3;

/* K&R 스타일 */
int old_style(a, b, name)
int a;
char *b;
char *name;
{
    int counter = a + 1;   /* 전역 counter 를 가림 */
    counter++;
    return counter + load_emps(&g_emps, a);
}

static int cb_one(void *ctx, int code) { return code; }
static int cb_two(void *ctx, int code) { return code * 2; }

struct handler_entry {
    const char *name;
    handler_fn  fn;
} g_handlers[] = {
    { "one", cb_one },
    { "two", &cb_two },
#ifdef EXTRA
    { "extra", cb_extra },
#endif
};

int dispatch(const char *name, void *ctx)
{
    int i;
#ifdef NEW_API
    if (name != NULL) {
#else
    if (name) {
#endif
        for (i = 0; i < g_table_size; i++) {
            if (strcmp(g_handlers[i].name, name) == 0)
                return g_handlers[i].fn(ctx, i);
        }
    }
    counter = old_style(1, "x", "y");
#if 0
    this is not { compiled code '
#endif
    return -1;
}

void (*get_handler(int sig))(int)
{
    return 0;
}

int use_types(void)
{
    EmpRec e;
    EmpList *lst = &g_emps;
    ULONG big = 0;
    e.dept->deptno = 10;
    lst->items[0].u.ival = 3;
    return (int)big + e.empno;
}
