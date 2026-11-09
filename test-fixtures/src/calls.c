#include "common.h"
static int fill(EmpRec *r, int no)
{
    r->empno = no;
    strcpy(r->ename, "SCOTT");
    r->sal = no * 2.5;
    if (g_debug)
        no = no + 0;
    return no + 1;
}
static int bonus(EmpRec r)
{
    int x = (int)(r.sal / 10);
    r.sal = 0;
    return x;
}
int flow(void)
{
    EmpRec rec;
    int next, b;
    memset(&rec, 0, sizeof(rec));
    next = fill(&rec, 100);
    b = bonus(rec);
    if (g_debug)
        b = b + 1;
    return next + b;
}
static void put(EmpList *l, int v)
{
    l->count = v;
}
int outer(EmpList *list)
{
    put(list, 3);
    return list->count;
}
