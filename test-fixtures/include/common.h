#ifndef COMMON_H
#define COMMON_H

#include <stdio.h>
#include "types.h"

#define MAX_NAME   30
#define LOG_ERR(fmt, ...) \
    log_write(LOG_LEVEL_ERR, __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#define SQL_OK()  (sqlca.sqlcode == 0)

typedef enum log_level {
    LOG_LEVEL_DBG = 0,
    LOG_LEVEL_INF,
    LOG_LEVEL_ERR = 10
} LogLevel;

typedef struct emp_rec {
    int    empno;
    char   ename[MAX_NAME + 1];
    double sal;
    struct dept_rec *dept;
    union {
        int   ival;
        char *sval;
    } u;
    int (*on_change)(struct emp_rec *self, int field);
} EmpRec;

struct dept_rec {
    int  deptno;
    char dname[20];
};

typedef struct {
    int count;
    EmpRec *items;
} EmpList;

extern int g_debug;
extern EmpList g_emps;

int  log_write(LogLevel lv, const char *file, int line, const char *fmt, ...);
int  load_emps(EmpList *list, int deptno);
static int helper_static(void);

#ifdef __cplusplus
extern "C" {
#endif
void c_linkage_fn(int x);
#ifdef __cplusplus
}
#endif

#endif /* COMMON_H */
